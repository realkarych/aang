"""Session transcripts: locate, index into turns, and resolve citations against them.

This is the deterministic half of R4 (docs/spec.md): the model writes the map and cites
by verbatim quote; this module decides whether that quote really occurs in the session.
A quote that cannot be found leaves the citation unverified — that is the safe direction.
Nothing here shells out, calls a model, or touches the network.

Quote matching rule (the security boundary of the tool):
  Both quote and turn text are canonicalized to a sequence of tokens — words (letters,
  digits, marks), and meaning-bearing symbols (math/currency/other symbols such as
  `< > = + | ~ $`) — separated by single spaces. Case, whitespace, all punctuation
  (quotes, dashes, commas, periods, brackets, `@ # % & / \\ _`), modifier symbols
  (backticks, `^`) and the letter `ё`/`е` distinction are ignored. A quote verifies iff
  its canonical text occurs in the turn's canonical text **on token boundaries**: every
  word of the quote, whole, in the quote's order, with nothing in between. No partial
  words at the edges — `possible` must never verify against `impossible`.
  A quote must contain at least 3 words (a word is a token with a letter in it —
  symbols and bare numbers do not count) and 12 characters.
  An ellipsis (`...` / `…`) inside a quote splits it into fragments that must each be
  found, in order, in the same turn, with at most 50 tokens elided between consecutive
  fragments; each fragment then needs at least 4 words. A match that used an ellipsis is
  `ok` but never "clean": its `reason` says how many words were skipped, so the viewer
  can tell a verbatim citation from a stitched one.
"""

import bisect
import glob
import json
import os
import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

MESSAGE_TYPES = ("user", "assistant")

# Text that arrives as a `user` record without a person having typed it: slash-command
# echoes and their output, subagent reports and task notifications relayed into the
# session, system reminders. A text part that opens with one of these is not the
# conversation and is never indexed — otherwise a subagent's sentence would verify as
# the user's words.
INJECTED_PREFIXES = (
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<local-command-caveat>",
    "<task-notification",
    "<teammate-message",
    "<system-reminder>",
    "Another Claude session sent a message",
)
MIN_QUOTE_WORDS = 3
MIN_FRAGMENT_WORDS = 4  # per fragment, when the quote contains an ellipsis
MIN_QUOTE_CHARS = 12
MAX_GAP_TOKENS = 50  # tokens an ellipsis may skip between consecutive fragments
EXCERPT_CONTEXT = 200
EXCERPT_FALLBACK = 300
EXCERPT_MAX = 1000

# `(...)` is a code placeholder, not an elision: `f(...)` is quoted verbatim. `[...]` still
# splits — it is the editorial elision mark.
_ELLIPSIS_RE = re.compile(r"(?<!\()(?:\.\s*){3,}|…")
_MULTI_SPACE_RE = re.compile(r"\s+")


# ----------------------------------------------------------------------------- find

def default_roots():  # type: () -> List[str]
    return [os.path.join(os.path.expanduser("~"), ".claude", "projects")]


def find_session(session_id=None, roots=None):  # type: (Optional[str], Optional[List[str]]) -> Optional[str]
    """Path to a session JSONL under `<root>/<project>/`, or None.

    With `session_id`: the file named `<session_id>.jsonl`, or a unique prefix match.
    Without: the most recently modified session file. Subagent and memory transcripts
    (`<project>/<session>/subagents/`, `<project>/memory/`) are never sessions.
    Missing roots are a normal state.
    """
    candidates = []  # type: List[str]
    for root in roots if roots is not None else default_roots():
        try:
            root = os.path.expanduser(root)
            if not os.path.isdir(root):
                continue
            for path in glob.iglob(os.path.join(glob.escape(root), "*", "*.jsonl")):
                if os.path.isfile(path):
                    candidates.append(path)
        except (OSError, ValueError):
            continue
    if not candidates:
        return None

    if session_id:
        exact = [p for p in candidates if os.path.basename(p) == session_id + ".jsonl"]
        if exact:
            return _newest(exact)
        prefixed = [p for p in candidates if os.path.basename(p).startswith(session_id)]
        if len(prefixed) == 1:
            return prefixed[0]
        return None
    return _newest(candidates)


def _newest(paths):  # type: (List[str]) -> Optional[str]
    best = None  # type: Optional[str]
    best_key = None  # type: Optional[Tuple[float, str]]
    for path in paths:
        try:
            key = (os.path.getmtime(path), path)
        except OSError:
            continue
        if best_key is None or key > best_key:
            best, best_key = path, key
    return best


# ----------------------------------------------------------------------------- index

def index(path, text_cap=None):  # type: (Optional[str], Optional[int]) -> List[Dict[str, Any]]
    """Turns of a session, numbered from 1 in file order.

    A turn is a top-level message: a `user` or `assistant` record carrying text. An
    assistant message is written as one record per content block, all sharing
    `message.id`; consecutive records with the same id form one turn. Skipped: control
    records, `isSidechain`, `isMeta` and `isCompactSummary` (injected content and the
    model's own summary, not the person's words), user text parts that open with an
    `INJECTED_PREFIXES` wrapper (slash-command echoes, relayed subagent reports, task
    notifications, system reminders), and messages whose content is only tool_use /
    tool_result / thinking.

    `text` is the text blocks joined with newlines; `text_cap` truncates it (None keeps
    it whole so every sentence of a long turn stays citable). The file is streamed;
    malformed or truncated lines are skipped, since the session is usually still live.
    """
    turns = []  # type: List[Dict[str, Any]]
    if not path:
        return turns
    try:
        handle = open(path, "r", encoding="utf-8", errors="replace")
    except (OSError, TypeError):
        return turns

    group_id = None  # type: Optional[str]
    group = None  # type: Optional[Dict[str, Any]]

    def flush():
        if group is not None and group["parts"]:
            _append_turn(turns, group, text_cap)

    with handle:
        for line in handle:
            record = _parse_line(line)
            if record is None:
                continue
            rtype = record.get("type")
            if rtype not in MESSAGE_TYPES:
                continue
            if record.get("isSidechain") or record.get("isMeta") or record.get("isCompactSummary"):
                continue
            message = record.get("message")
            if not isinstance(message, dict):
                continue
            parts = _text_parts(message.get("content"))
            if rtype == "user":
                parts = [part for part in parts if not _injected(part)]

            if rtype == "assistant":
                message_id = message.get("id")
                if group is not None and group_id is not None and message_id == group_id:
                    if parts:
                        group["parts"].extend(parts)
                        if group["uuid"] is None:
                            group["uuid"] = record.get("uuid")
                            group["ts"] = record.get("timestamp")
                    continue
                flush()
                group_id = message_id if isinstance(message_id, str) else None
                group = {
                    "role": "assistant",
                    "parts": list(parts),
                    "uuid": record.get("uuid") if parts else None,
                    "ts": record.get("timestamp") if parts else None,
                }
                if group_id is None:
                    flush()
                    group = None
                continue

            # user
            flush()
            group_id, group = None, None
            if parts:
                _append_turn(turns, {
                    "role": "user",
                    "parts": parts,
                    "uuid": record.get("uuid"),
                    "ts": record.get("timestamp"),
                }, text_cap)
        flush()
    return turns


def _parse_line(line):  # type: (str) -> Optional[Dict[str, Any]]
    line = line.strip()
    if not line:
        return None
    try:
        record = json.loads(line)
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def _text_parts(content):  # type: (Any) -> List[str]
    if isinstance(content, str):
        return [content] if content.strip() else []
    parts = []  # type: List[str]
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text)
    return parts


def _injected(part):  # type: (str) -> bool
    """True for a user text part nobody typed — see INJECTED_PREFIXES."""
    head = part.lstrip()
    return any(head.startswith(prefix) for prefix in INJECTED_PREFIXES)


def _append_turn(turns, group, text_cap):  # type: (List[Dict[str, Any]], Dict[str, Any], Optional[int]) -> None
    text = "\n".join(group["parts"])
    if text_cap is not None and len(text) > text_cap:
        text = text[:text_cap]
    uuid = group.get("uuid")
    ts = group.get("ts")
    turns.append({
        "turn": len(turns) + 1,
        "role": group["role"],
        "ts": ts if isinstance(ts, str) else None,
        "uuid": uuid if isinstance(uuid, str) else "",
        "text": text,
    })


# ----------------------------------------------------------------------------- canon

def _classify(char):  # type: (str) -> str
    """'w' word char, 's' standalone symbol, ' ' separator."""
    category = unicodedata.category(char)
    lead = category[0]
    if lead in ("L", "N", "M"):
        return "w"
    if lead == "S":
        return " " if category == "Sk" else "s"
    return " "


def _canon(text):  # type: (str) -> Tuple[str, List[int], List[Tuple[int, int]]]
    """Canonical string, canonical offset of each token, original (start, end) of each token.

    Normalization is per source character so token spans map back to the original text.
    """
    tokens = []  # type: List[str]
    spans = []  # type: List[Tuple[int, int]]
    word = []  # type: List[str]
    word_start = -1
    for i, raw in enumerate(text):
        normalized = unicodedata.normalize("NFKC", raw).casefold().replace("ё", "е")
        for char in normalized:
            kind = _classify(char)
            if kind == "w":
                if not word:
                    word_start = i
                word.append(char)
                continue
            if word:
                tokens.append("".join(word))
                spans.append((word_start, i))
                word = []
            if kind == "s":
                tokens.append(char)
                spans.append((i, i + 1))
    if word:
        tokens.append("".join(word))
        spans.append((word_start, len(text)))

    offsets = []  # type: List[int]
    pos = 0
    for token in tokens:
        offsets.append(pos)
        pos += len(token) + 1
    return " ".join(tokens), offsets, spans


def _fragments(quote):  # type: (str) -> List[str]
    """Canonical fragments of a quote split on ellipses; empty fragments dropped."""
    out = []  # type: List[str]
    for piece in _ELLIPSIS_RE.split(quote):
        canon, _, _ = _canon(piece)
        if canon:
            out.append(canon)
    return out


def _word_count(canon):  # type: (str) -> int
    """Tokens with a letter in them — a symbol such as `|` or a bare number such as
    `16` is not evidence, so `«16 коммитов, 15»` is one word, not three."""
    return sum(1 for token in canon.split(" ") if _has_letter(token))


def _has_letter(token):  # type: (str) -> bool
    return any(unicodedata.category(char)[0] == "L" for char in token)


def _fragment_too_short(canon, min_words):  # type: (str, int) -> bool
    return _word_count(canon) < min_words or len(canon) < MIN_QUOTE_CHARS


class _Indexed(object):
    """A turn with its canonical text, built once per resolve() call."""

    __slots__ = ("turn", "canon", "offsets", "spans")

    def __init__(self, turn):  # type: (Dict[str, Any]) -> None
        self.turn = turn
        self.canon, self.offsets, self.spans = _canon(turn.get("text") or "")

    def _occurrences(self, fragment, from_tok, to_tok):  # type: (str, int, int) -> List[Tuple[int, int]]
        """Token ranges where `fragment` occurs on token boundaries, starting within
        [from_tok, to_tok]."""
        out = []  # type: List[Tuple[int, int]]
        if from_tok >= len(self.offsets):
            return out
        at = self.offsets[from_tok]
        while True:
            at = self.canon.find(fragment, at)
            if at < 0:
                break
            end = at + len(fragment)
            starts_token = at == 0 or self.canon[at - 1] == " "
            ends_token = end == len(self.canon) or self.canon[end] == " "
            if starts_token and ends_token:
                start_tok = bisect.bisect_right(self.offsets, at) - 1
                if start_tok > to_tok:
                    break
                end_tok = bisect.bisect_right(self.offsets, end - 1) - 1
                out.append((start_tok, end_tok))
            at += 1
        return out

    def find(self, fragments):  # type: (List[str]) -> Optional[Tuple[int, int, int]]
        """(start, end, skipped) in original text covering all fragments in order, or None.

        Consecutive fragments may be at most MAX_GAP_TOKENS apart; `skipped` is the total
        number of tokens elided. Occurrences are searched exhaustively within the gap
        window, so a repeated first fragment cannot hide a valid later placement.
        """
        total = len(self.offsets)
        if total == 0 or not fragments:
            return None

        def walk(k, from_tok, to_tok):  # type: (int, int, int) -> Optional[List[Tuple[int, int]]]
            for start_tok, end_tok in self._occurrences(fragments[k], from_tok, to_tok):
                if k + 1 == len(fragments):
                    return [(start_tok, end_tok)]
                rest = walk(k + 1, end_tok + 1, end_tok + 1 + MAX_GAP_TOKENS)
                if rest is not None:
                    return [(start_tok, end_tok)] + rest
            return None

        path = walk(0, 0, total - 1)
        if path is None:
            return None
        skipped = sum(path[i + 1][0] - path[i][1] - 1 for i in range(len(path) - 1))
        return self.spans[path[0][0]][0], self.spans[path[-1][1]][1], skipped


# ----------------------------------------------------------------------------- resolve

def resolve(cites, turns):  # type: (Any, List[Dict[str, Any]]) -> List[Dict[str, Any]]
    """Check each citation against the indexed turns.

    Each result: `{"turn": int|None, "role": str|None, "ok": bool, "excerpt": str,
    "reason": str, "quote": str, "matches": [int, ...]}`.

    - `turn` absent/null: the quote is searched in every turn and `turn` is filled in.
      Several matching turns are all reported in `matches`; `turn` is the last one (in
      a rewound conversation the later copy is the live one) and `reason` says so.
    - `turn` given: the quote must appear in that turn. If it does not, `ok` is False
      even when the quote exists elsewhere — the mismatch is reported, not repaired.
    - `role` given: must equal the role of the turn the quote was found in.
    - No quote, or a quote too short to be evidence, is never `ok`.
    `excerpt` is ±200 chars around the match, else the turn's first 300 chars.
    """
    turns = [t for t in (turns or []) if isinstance(t, dict)]
    by_number = {}  # type: Dict[int, _Indexed]
    indexed = []  # type: List[_Indexed]
    for turn in turns:
        number = turn.get("turn")
        if isinstance(number, int) and not isinstance(number, bool):
            item = _Indexed(turn)
            indexed.append(item)
            by_number[number] = item

    results = []  # type: List[Dict[str, Any]]
    for cite in (cites if isinstance(cites, list) else []):
        results.append(_resolve_one(cite, indexed, by_number, len(turns)))
    return results


def _resolve_one(cite, indexed, by_number, total):
    # type: (Any, List[_Indexed], Dict[int, _Indexed], int) -> Dict[str, Any]
    if not isinstance(cite, dict):
        return _result(None, None, False, "", "ссылка не является объектом", "", [])

    quote = cite.get("quote")
    quote = quote if isinstance(quote, str) else ""
    wanted_turn = cite.get("turn")
    if isinstance(wanted_turn, bool) or not isinstance(wanted_turn, int):
        wanted_turn = None
    wanted_role = cite.get("role") if cite.get("role") in ("user", "assistant") else None

    # The cited turn, if any, must exist before anything else is judged.
    anchor = by_number.get(wanted_turn) if wanted_turn is not None else None
    if wanted_turn is not None and anchor is None:
        return _result(wanted_turn, None, False, "",
                       "хода %d нет в транскрипте (всего ходов: %d)" % (wanted_turn, total), quote, [])

    fragments = _fragments(quote)
    if not fragments:
        return _result(wanted_turn, _role(anchor), False, _fallback(anchor),
                       "нет цитаты — без дословной цитаты ссылку нельзя проверить", quote, [])
    min_words = MIN_FRAGMENT_WORDS if len(fragments) > 1 else MIN_QUOTE_WORDS
    for fragment in fragments:
        if _fragment_too_short(fragment, min_words):
            return _result(wanted_turn, _role(anchor), False, _fallback(anchor),
                           "цитата слишком короткая, чтобы её проверить: «%s» "
                           "(нужно минимум %d слова и %d символов%s)"
                           % (fragment, min_words, MIN_QUOTE_CHARS,
                              " в каждом фрагменте" if len(fragments) > 1 else ""), quote, [])

    matches = []  # type: List[Tuple[_Indexed, Tuple[int, int, int]]]
    for item in indexed:
        span = item.find(fragments)
        if span is not None:
            matches.append((item, span))
    match_numbers = [m[0].turn["turn"] for m in matches]

    if anchor is not None:
        hit = next((m for m in matches if m[0] is anchor), None)
        if hit is None:
            reason = "цитата не найдена в ходе %d" % wanted_turn
            if match_numbers:
                reason += ", но встречается в %s" % _list_turns(match_numbers)
            return _result(wanted_turn, _role(anchor), False, _fallback(anchor), reason, quote, match_numbers)
        return _finish(hit, wanted_role, [], len(fragments) > 1, quote, match_numbers)

    if not matches:
        return _result(None, None, False, "", "цитата не найдена ни в одном ходе транскрипта", quote, [])
    hit = matches[-1]
    notes = []  # type: List[str]
    if len(matches) > 1:
        notes.append("цитата встречается в %s; показан последний" % _list_turns(match_numbers))
    return _finish(hit, wanted_role, notes, len(fragments) > 1, quote, match_numbers)


def _finish(hit, wanted_role, notes, elided, quote, match_numbers):
    # type: (Tuple[_Indexed, Tuple[int, int, int]], Optional[str], List[str], bool, str, List[int]) -> Dict[str, Any]
    item, (start, end, skipped) = hit
    span = (start, end)
    number = item.turn["turn"]
    role = _role(item)
    excerpt = _excerpt(item.turn.get("text") or "", span)
    # A stitched quote is never "clean": the viewer must be able to tell it apart.
    if elided:
        notes = ["цитата с пропусками: пропущено %d %s" % (skipped, _words(skipped))] + notes
    reason = "; ".join(notes)
    if wanted_role is not None and role is not None and role != wanted_role:
        return _result(number, role, False, excerpt,
                       "цитата найдена в ходе %d, но это реплика %s, а в ссылке указано %s"
                       % (number, role, wanted_role), quote, match_numbers)
    return _result(number, role, True, excerpt, reason, quote, match_numbers)


def _result(turn, role, ok, excerpt, reason, quote, matches):
    # type: (Optional[int], Optional[str], bool, str, str, str, List[int]) -> Dict[str, Any]
    return {
        "turn": turn,
        "role": role,
        "ok": ok,
        "excerpt": excerpt,
        "reason": reason,
        "quote": quote,
        "matches": list(matches),
    }


def _role(item):  # type: (Optional[_Indexed]) -> Optional[str]
    if item is None:
        return None
    role = item.turn.get("role")
    return role if isinstance(role, str) else None


def _words(n):  # type: (int) -> str
    """Russian plural of «слово» for a count."""
    if n % 10 == 1 and n % 100 != 11:
        return "слово"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return "слова"
    return "слов"


def _list_turns(numbers):  # type: (List[int]) -> str
    return "ходах " + ", ".join(str(n) for n in numbers) if len(numbers) > 1 else "ходе %d" % numbers[0]


def _fallback(item):  # type: (Optional[_Indexed]) -> str
    if item is None:
        return ""
    text = item.turn.get("text") or ""
    return _tidy(text[:EXCERPT_FALLBACK])


def _excerpt(text, span):  # type: (str, Tuple[int, int]) -> str
    start, end = span
    lo = max(0, start - EXCERPT_CONTEXT)
    hi = min(len(text), end + EXCERPT_CONTEXT)
    excerpt = text[lo:hi]
    if len(excerpt) > EXCERPT_MAX:
        half = EXCERPT_MAX // 2
        excerpt = excerpt[:half] + " […] " + excerpt[-half:]
    prefix = "…" if lo > 0 else ""
    suffix = "…" if hi < len(text) else ""
    return prefix + _tidy(excerpt) + suffix


def _tidy(text):  # type: (str) -> str
    return _MULTI_SPACE_RE.sub(" ", text).strip()
