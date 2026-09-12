"""Triage: which cell a node falls in, and what a verdict does to it.

Spec: docs/superpowers/specs/2026-09-11-live-companion-design.md, «Ячейки» and «Вердикт».
The cell is derived — never stored — from `status`, `triage`, `kind`, `decided_by` and
`seen_at`; the server puts it on each node of `/api/map` as `cell`, the export groups by
it, and the viewer's `ui/model.js` carries the same rule (a test compares the orders).
"""

from typing import Any, Dict, Optional, Tuple

CELLS = (
    ("inbox", "Входящее", "предложения агента и вопросы, которых вы ещё не видели"),
    ("research", "Ресерч", "под вопросом: нужно исследовать"),
    ("discuss", "Обсудить", "под вопросом: нужно обсудить"),
    ("confirmed", "Подтверждено", "принято — вами или агентом"),
    ("rejected", "Отвергнуто", "остаётся в записи, чтобы не предлагать снова"),
    ("tacit", "Неявные решения", "приняты без того, чтобы кто-то выбирал"),
    ("orphaned", "Осиротело решениями", "вопросы, которые повисли из-за принятого решения"),
    ("hanging", "Просто висит", "к этому не вернулись; какое решение виновато — не названо"),
    ("decisions", "Решения", "заменённые и предложенные вами"),
)  # type: Tuple[Tuple[str, str, str], ...]

VERDICTS = ("confirmed", "rejected", "research", "discuss")


def is_unseen(node):  # type: (Dict[str, Any]) -> bool
    """Never marked seen, or marked seen before the node (re)entered the map."""
    seen = node.get("seen_at") or ""
    added = node.get("added_at") or ""
    if not seen:
        return True
    return bool(added) and seen < added


def _has_rel(node, rel):  # type: (Dict[str, Any], str) -> bool
    return any(isinstance(r, dict) and r.get("rel") == rel for r in (node.get("relates") or []))


def cell(node):  # type: (Dict[str, Any]) -> str
    """First matching rule of the spec table."""
    kind = node.get("kind")
    status = node.get("status")
    if status == "rejected":
        return "rejected"
    if node.get("triage") == "research":
        return "research"
    if node.get("triage") == "discuss":
        return "discuss"
    if kind == "decision" and status == "accepted":
        return "confirmed"
    if kind == "decision" and status == "proposed" and node.get("decided_by") == "agent":
        return "inbox"
    if kind == "open" and is_unseen(node):
        return "inbox"
    if kind == "tacit":
        return "tacit"
    if kind == "open":
        return "orphaned" if _has_rel(node, "orphaned_by") else "hanging"
    return "decisions"


def apply_verdict(node, verdict, text):  # type: (Dict[str, Any], str, Optional[str]) -> Optional[str]
    """Mutate `node` per the verdict table; return an error string, or None on success.

    The last branch is research / discuss: both put the node back under question.
    """
    text = (text or "").strip()
    kind, status = node.get("kind"), node.get("status")
    if verdict not in VERDICTS:
        return "неизвестный вердикт %r — ожидается один из %s" % (verdict, "/".join(VERDICTS))
    if status == "superseded":
        return "узел %s заменён другим — вердикт ставится на замену" % node.get("id")

    if verdict == "confirmed":
        if kind == "open":
            if not text:
                return "чтобы подтвердить открытый вопрос, нужен ответ — это и есть решение"
            node["decision"] = text
        node["kind"] = "decision"
        node["status"] = "accepted"
        node["decided_by"] = "user"
        node["triage"] = None
    elif verdict == "rejected":
        if kind == "open":
            if not text:
                return "чтобы отвергнуть открытый вопрос, скажите почему — это станет решением"
            node["decision"] = text
            node["kind"] = "decision"
            node["decided_by"] = "user"
        elif text:
            against = [a for a in (node.get("against") or []) if isinstance(a, str)]
            against.append(text)
            node["against"] = against
        node["status"] = "rejected"
        node["triage"] = None
    else:
        if status == "rejected":
            return "узел %s отвергнут — сначала подтвердите его, потом ставьте под вопрос" % node.get("id")
        node["status"] = "proposed"
        node["triage"] = verdict
    node["hand_edited"] = True
    return None


def titles():  # type: () -> Dict[str, str]
    return dict((key, title) for key, title, _ in CELLS)
