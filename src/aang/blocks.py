"""Blocks, lines and topics: how the read-only viewer and the export arrange the map.

Spec: docs/superpowers/specs/2026-09-12-three-blocks-design.md, «Блоки», «Строка», «Темы».
Everything here is derived from `kind`, `status`, `decided_by`, `triage`, `topic`,
`relates`, `superseded_by` and `added_at`; nothing is stored. `ui/model.js` carries the
same rules for the screen, and a test in `tests/test_server.py` compares the two.
"""

from typing import Any, Dict, List, Optional, Tuple

BLOCKS = (
    ("decided", "Решено", "в силе — выбрано или принято молча"),
    ("open", "Под вопросом", "ждёт вас: предложено агентом, спрошено, отложено"),
    ("rejected", "Отвергнуто", "остаётся в записи, чтобы не предлагать снова"),
)  # type: Tuple[Tuple[str, str, str], ...]

NAME_WORDS = 3


def block(node):  # type: (Dict[str, Any]) -> Optional[str]
    """The block a node is listed under; None for a superseded node, which lives inside
    the expansion of what replaced it."""
    status = node.get("status")
    if status == "rejected":
        return "rejected"
    if status == "superseded":
        return None
    if node.get("kind") == "open" or status == "proposed" or node.get("triage"):
        return "open"
    return "decided"


def line(node):  # type: (Dict[str, Any]) -> Tuple[str, str, str]
    """Glyph, one-word verb and text of a node's line. Triage outranks everything else:
    a node under research reads «изучить» whoever proposed it."""
    kind, status = node.get("kind"), node.get("status")
    text = (node.get("question") if kind == "open" else node.get("decision")) or ""
    triage = node.get("triage")
    if triage == "research":
        return ("?", "изучить", text)
    if triage == "discuss":
        return ("?", "обсудить", text)
    if status == "rejected":
        return ("✖", "отвергнуто", text)
    if status == "superseded":
        return ("●", "заменено", text)
    if kind == "open":
        return ("○", "открыто", text)
    if kind == "tacit":
        return ("◌", "молча", text)
    if status == "proposed":
        if node.get("decided_by") == "agent":
            return ("◆", "агент сам", text)
        return ("◇", "предложено", text)
    return ("●", "решили", text)


def topic_key(name):  # type: (Any) -> str
    """Two spellings of one topic compare equal: whitespace collapsed, case folded."""
    if not isinstance(name, str):
        return ""
    return " ".join(name.split()).casefold()


def _targets(node):  # type: (Dict[str, Any]) -> List[str]
    out = [r.get("to") for r in node.get("relates") or [] if isinstance(r, dict)]
    out.append(node.get("superseded_by"))
    return [t for t in out if isinstance(t, str) and t]


def _fallback_name(node):  # type: (Dict[str, Any]) -> str
    words = str(node.get("question") or "").split()
    if not words:
        return str(node.get("id") or "")
    name = " ".join(words[:NAME_WORDS])
    return name + "…" if len(words) > NAME_WORDS else name


def topics(nodes):  # type: (List[Any]) -> List[Dict[str, Any]]
    """Topics in display order, each `{"name", "ids"}` with ids in list order.

    A node with a `topic` is in that topic. A node without one joins the connected
    component its edges (`relates`, `superseded_by`, both directions) put it in: the
    component's earliest named node lends its topic, and a component nobody named is
    called by the first three words of its earliest question. Two spellings of one topic
    are one topic, shown under the spelling of the earliest-listed node in it that carries
    a `topic`; a topic nobody named is shown under the name its earliest component lent
    it. Topics sort by the latest `added_at` among their nodes, then by the latest list
    position — the topic that moved last comes first. Non-dict entries and nodes without
    an id are skipped.
    """
    nodes = [n for n in nodes if isinstance(n, dict) and isinstance(n.get("id"), str) and n["id"]]
    index = dict((n["id"], i) for i, n in enumerate(nodes))
    by_id = dict((n["id"], n) for n in nodes)
    parent = dict((n["id"], n["id"]) for n in nodes)

    def find(x):  # type: (str) -> str
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for n in nodes:
        for target in _targets(n):
            if target in parent:
                a, b = find(n["id"]), find(target)
                if a != b:
                    first, second = (a, b) if index[a] < index[b] else (b, a)
                    parent[second] = first

    members = {}  # type: Dict[str, List[str]]
    for n in nodes:
        members.setdefault(find(n["id"]), []).append(n["id"])

    keyed = {}  # type: Dict[str, List[str]]
    lent_names = {}  # type: Dict[str, str]

    for root in sorted(members, key=lambda r: index[r]):
        ids = members[root]
        named = [i for i in ids if topic_key(by_id[i].get("topic"))]
        lent = by_id[named[0]]["topic"] if named else _fallback_name(by_id[ids[0]])
        if not named:
            lent_names.setdefault(topic_key(lent), " ".join(lent.split()))
        for i in ids:
            own = by_id[i].get("topic")
            keyed.setdefault(topic_key(own if topic_key(own) else lent), []).append(i)

    out = []  # type: List[Dict[str, Any]]
    for key, ids in keyed.items():
        ids.sort(key=lambda i: index[i])
        spelled = [i for i in ids if topic_key(by_id[i].get("topic"))]
        name = " ".join(by_id[spelled[0]]["topic"].split()) if spelled else lent_names[key]
        out.append({"name": name, "ids": ids})

    def rank(group):  # type: (Dict[str, Any]) -> Tuple[str, int]
        ids = group["ids"]
        return (max(str(by_id[i].get("added_at") or "") for i in ids), max(index[i] for i in ids))

    out.sort(key=rank, reverse=True)
    return out


def topic_of(nodes):  # type: (List[Any]) -> Dict[str, str]
    """Node id → resolved topic name, what `server.annotate` puts on each node."""
    names = {}  # type: Dict[str, str]
    for group in topics(nodes):
        for node_id in group["ids"]:
            names[node_id] = group["name"]
    return names


def titles():  # type: () -> Dict[str, str]
    return dict((key, title) for key, title, _ in BLOCKS)
