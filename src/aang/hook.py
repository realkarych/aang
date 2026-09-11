"""`aang hook`: the harness calls this on SessionStart, UserPromptSubmit and Stop.

Spec: docs/superpowers/specs/2026-09-11-live-companion-design.md, «Хук». Both Claude Code
and Codex send the same JSON on stdin (`session_id`, `transcript_path`, `cwd`,
`hook_event_name`, …) and read the same `hookSpecificOutput.additionalContext`; only the
"continue the turn" answer from Stop differs. Exit code is always 0 and stdout is empty
whenever there is nothing to say: a broken aang must never break a session.
"""

import datetime
import json
import os
import re
from typing import Any, Dict, List, Optional

from . import server, session, store, transcript

ID_RE = re.compile(r"\b([dto]\d+)\b")
MAX_DEIXIS = 5
REL_WORDS = {"orphaned_by": "осиротело решением", "rests_on": "держится на", "moots": "сделало неактуальным"}
VERDICT_WORDS = {"confirmed": "подтвердил", "rejected": "отверг", "research": "отправил в ресерч", "discuss": "отправил обсудить"}


def run(stdin_text, environ, out, err, now=None):  # type: (str, Dict[str, str], Any, Any, Optional[str]) -> int
    """Handle one hook event; always 0, so nothing here can fail the session.

    The except is deliberately broad: a corrupt map, an unreadable transcript and a bug
    in aang itself must all end the same way — a line on stderr, nothing on stdout, and
    the harness carrying on. `_after` is the work that may only happen once the answer
    has reached the harness (draining the outbox); it is taken off the answer before
    the answer is serialized, because a callable is not JSON.
    """
    try:
        payload = json.loads(stdin_text) if stdin_text.strip() else {}
        if not isinstance(payload, dict):
            raise ValueError("hook payload is not an object")
        answer = handle(payload, environ, now or session.now_iso())
        if answer:
            after = answer.pop("_after", None)
            out.write(json.dumps(answer, ensure_ascii=False))
            out.flush()
            if after:
                after()
    except Exception as exc:
        err.write("aang hook: %s\n" % exc)
    return 0


def harness_of(payload, environ):  # type: (Dict[str, Any], Dict[str, str]) -> str
    """Which harness sent this event, decided by the fields only it sends."""
    if "prompt_id" in payload or "turn_number" in payload:
        return "claude"
    if "turn_id" in payload:
        return "codex"
    return "claude" if environ.get("CLAUDE_CODE_SESSION_ID") else "codex"


def handle(payload, environ, now):  # type: (Dict[str, Any], Dict[str, str], str) -> Optional[Dict[str, Any]]
    """The answer for one event, or None when aang has nothing to say.

    Every event refreshes `.aang/session.json` — that is how `merge`, `check` and the
    viewer learn which transcript this map belongs to. `last_nudge_turn` is not touched
    here, so it survives a SessionStart in the middle of a session.
    """
    root = session.find_root(payload.get("cwd") or ".")
    if not root:
        return None
    harness = harness_of(payload, environ)
    session.update(root, harness=harness, session_id=payload.get("session_id") or "",
                   transcript_path=payload.get("transcript_path") or "", cwd=payload.get("cwd") or "",
                   last_event_at=now)
    event = payload.get("hook_event_name")
    if event == "UserPromptSubmit":
        return _prompt(root, payload)
    if event == "Stop":
        return _stop(root, payload, harness, now)
    return None


def _view(root):  # type: (str) -> Dict[str, Any]
    """The map as the viewer sees it, against the transcript the session file names."""
    map_dict = store.load(root)
    path = session.transcript_path(root)
    turns = transcript.index(path) if path else []
    error = None if turns else "транскрипт не найден"
    return server.annotate(map_dict, turns, error, path, session.read(root), root)


def _prompt(root, payload):  # type: (str, Dict[str, Any]) -> Optional[Dict[str, Any]]
    view = _view(root)
    if view["errors"]:
        return None
    text = prompt_context(root, view, str(payload.get("prompt") or ""))
    if not text:
        return None
    answer = {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": text}}
    if session.outbox_read(root):
        answer["_after"] = lambda: session.outbox_clear(root)
    return answer


def prompt_context(root, view, prompt):  # type: (str, Dict[str, Any], str) -> str
    """What the agent should know before answering this prompt, or "" when nothing.

    Three parts: what the human did in the viewer since the last turn, the full text of
    every map node the prompt names by id, and how far behind the map has fallen. The
    coverage line only rides along with one of the first two — on its own it would nag
    on every prompt, and aang stays quiet when it has nothing else to say.
    """
    by_id = dict((n["id"], n) for n in view["nodes"])
    parts = []  # type: List[str]
    events = session.outbox_read(root)
    if events:
        lines = ["Из вьюера aang с прошлого хода (обязательно отреагируй в ответе и учти при следующем обновлении карты):"]
        for e in events:
            node = by_id.get(e["node"])
            q = " «%s»" % node["question"] if node else ""
            word = VERDICT_WORDS.get(e.get("kind"), e.get("kind") or "?")
            tail = ""
            if e.get("text"):
                tail = " ответом: «%s»" % e["text"] if e.get("kind") == "confirmed" else ": «%s»" % e["text"]
            lines.append("- %s %s%s%s" % (word, e["node"], q, tail))
        parts.append("\n".join(lines))
    ids = []  # type: List[str]
    for found in ID_RE.findall(prompt):
        if found in by_id and found not in ids:
            ids.append(found)
    if ids:
        blocks = [_node_block(by_id[i]) for i in ids[:MAX_DEIXIS]]
        if len(ids) > MAX_DEIXIS:
            blocks.append("…и ещё %d: %s" % (len(ids) - MAX_DEIXIS, ", ".join(ids[MAX_DEIXIS:])))
        parts.append("Узлы карты aang, упомянутые в промпте:\n" + "\n".join(blocks))
    cov = view.get("coverage") or {}
    if parts and view.get("tail"):
        parts.append("Карта aang покрывает ходы до %s из %s." % (cov.get("covered_to"), cov.get("turns")))
    return "\n\n".join(parts)


def _node_block(n):  # type: (Dict[str, Any]) -> str
    """One node in full, including what the map derives around it."""
    lines = ["%s — %s" % (n["id"], n["question"])]
    lines.append("  вид: %s; статус: %s%s%s" % (
        n["kind"], n["status"],
        "; решил: %s" % n["decided_by"] if n.get("decided_by") else "",
        "; под вопросом: %s" % n["triage"] if n.get("triage") else ""))
    if n.get("decision"):
        lines.append("  решение: %s" % n["decision"])
    if n.get("why"):
        lines.append("  почему: %s" % n["why"])
    if n.get("consequence"):
        lines.append("  следствие: %s" % n["consequence"])
    rel = ["%s %s" % (REL_WORDS.get(r["rel"], r["rel"]), r["to"]) for r in n.get("relates") or []]
    holds = [r["from"] for r in n.get("related_by") or [] if r.get("rel") in ("rests_on", "orphaned_by")]
    if n.get("superseded_by"):
        rel.append("заменено %s" % n["superseded_by"])
    if rel:
        lines.append("  связи: " + "; ".join(rel))
    if holds:
        lines.append("  на этом держатся: " + ", ".join(holds))
    return "\n".join(lines)


def _stop(root, payload, harness, now):  # type: (str, Dict[str, Any], str, str) -> Optional[Dict[str, Any]]
    """Claude Code sends `stop_hook_active: false` when the turn already ended by itself."""
    if harness == "claude" and payload.get("stop_hook_active") is False:
        return None
    view = _view(root)
    reason = should_nudge(root, view, session.config(root), now)
    if not reason:
        return None
    session.update(root, last_nudge_turn=view["turns"])
    return continue_answer(harness, reason)


def should_nudge(root, view, cfg, now):  # type: (str, Dict[str, Any], Dict[str, int], str) -> Optional[str]
    """The reason text when the map should be refreshed now, else None.

    Silence wins every tie: an invalid map, an unreadable transcript, a candidate the
    model already wrote but nobody merged, or a turn that was nudged once all mean no.
    With nothing covered yet the whole transcript is the backlog, because `annotate`
    reports no tail when there is no «past» to measure it from.
    """
    if view["errors"] or view.get("transcript_error") or not view["turns"]:
        return None
    if os.path.exists(store.candidate_path(root)):
        return None
    data = session.read(root) or {}
    if view["turns"] <= int(data.get("last_nudge_turn") or 0):
        return None
    covered = view["coverage"].get("covered_to")
    if covered is None:
        user_since = sum(1 for t in transcript.index(view["transcript_path"]) if t["role"] == "user")
    else:
        user_since = sum(1 for t in view["tail"] if t["role"] == "user")
    minutes = _minutes_between(view.get("generated_at") or "", now)
    if user_since >= cfg["nudge_turns"] or (minutes is not None and minutes >= cfg["nudge_minutes"] and user_since >= 1):
        return ("aang: с последнего обновления карты прошло %d %s пользователя. Обнови карту сейчас: "
                "выполни скилл aang (Claude Code: инструмент Skill, skill \"aang\"; Codex: $aang). "
                "Не спрашивай разрешения — это плановое обновление. После обновления заверши ход как обычно."
                % (user_since, _turns_word(user_since)))
    return None


def continue_answer(harness, reason):  # type: (str, str) -> Dict[str, Any]
    """The «keep going, do this first» answer in the shape the harness understands."""
    if harness == "codex":
        return {"decision": "block", "reason": reason}
    return {"hookSpecificOutput": {"hookEventName": "Stop", "continueConversation": True, "continueReason": reason}}


def _minutes_between(then_iso, now_iso):  # type: (str, str) -> Optional[float]
    try:
        then = datetime.datetime.strptime(then_iso, "%Y-%m-%dT%H:%M:%SZ")
        now = datetime.datetime.strptime(now_iso, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None
    return (now - then).total_seconds() / 60.0


def _turns_word(n):  # type: (int) -> str
    """Russian plural of «ход» for a count."""
    if n % 10 == 1 and n % 100 != 11:
        return "ход"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return "хода"
    return "ходов"
