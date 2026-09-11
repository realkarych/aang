"""Map schema: validation and default-filling for `.aang/map.json`.

The format is pinned in docs/plan.md ("The map format"); `relates`, `added_at`, `decided_by`,
`triage`, and `seen_at` are specified in docs/superpowers/specs/2026-09-11-map-relations-and-search-design.md.
`validate` returns a list of error strings (empty when the map is valid); `normalize` fills defaults in place so
downstream code never guards for absent keys. Neither raises on bad input.

Error strings are user-facing (Russian); identifiers in them stay as written in the file.
"""

import re
from typing import Any, Dict, List, Optional

VERSION = 1

KINDS = ("decision", "tacit", "open")
STATUSES = ("accepted", "superseded", "proposed", "rejected")
DECIDERS = ("user", "agent")
TRIAGES = ("research", "discuss")
ROLES = ("user", "assistant")
_TRIAGE_STATUSES = ("proposed",)

# Typed relations a node may declare in `relates`. `superseded_by` stays a separate field
# (it sits on the old node, pointing forward) and does not move here.
RELS = ("orphaned_by", "rests_on", "moots")
MAX_RELATES = 3

# Ids the model writes in prose ("Осиротело решением d6"); a warning when there is no edge.
_PROSE_ID_RE = re.compile(r"\b([dto]\d+)\b")
_PROSE_FIELDS = ("why", "consequence", "question", "decision")

# Fields whose default is an empty string / list / bool / null.
_TEXT_FIELDS = ("question", "decision", "why", "consequence")
_LIST_FIELDS = ("against", "cites")


def _is_str(value):  # type: (Any) -> bool
    return isinstance(value, str)


def _node_label(node, position):  # type: (Any, int) -> str
    node_id = node.get("id") if isinstance(node, dict) else None
    if _is_str(node_id) and node_id:
        return "узел %s" % node_id
    return "узел #%d" % position


def validate(map_dict):  # type: (Any) -> List[str]
    """Return a list of validation errors for a map; empty means valid.

    Every error names the node (by id, or by position when it has no id) and the field.
    """
    errors = []  # type: List[str]
    if not isinstance(map_dict, dict):
        return ["карта: ожидался объект JSON, получен %s" % type(map_dict).__name__]

    version = map_dict.get("version")
    if version is None:
        errors.append("карта, поле version: отсутствует")
    elif version != VERSION or isinstance(version, bool):
        errors.append("карта, поле version: ожидается %d, получено %r" % (VERSION, version))

    for field in ("session_id", "generated_at", "title"):
        if field in map_dict and map_dict[field] is not None and not _is_str(map_dict[field]):
            errors.append("карта, поле %s: ожидается строка" % field)

    nodes = map_dict.get("nodes")
    if nodes is None:
        errors.append("карта, поле nodes: отсутствует")
        return errors
    if not isinstance(nodes, list):
        errors.append("карта, поле nodes: ожидается список")
        return errors

    # First pass: ids, so that supersede targets can be checked against the full set.
    ids = {}  # type: Dict[str, int]
    for pos, node in enumerate(nodes, 1):
        if not isinstance(node, dict):
            errors.append("узел #%d: ожидался объект, получен %s" % (pos, type(node).__name__))
            continue
        node_id = node.get("id")
        if not _is_str(node_id) or not node_id.strip():
            errors.append("узел #%d, поле id: отсутствует или пустой" % pos)
            continue
        if node_id in ids:
            errors.append("узел %s, поле id: дубликат (уже есть узел #%d)" % (node_id, ids[node_id]))
            continue
        ids[node_id] = pos

    for pos, node in enumerate(nodes, 1):
        if not isinstance(node, dict):
            continue
        errors.extend(_validate_node(node, pos, ids))

    errors.extend(_validate_supersede_chains(nodes, ids))
    return errors


def _validate_node(node, pos, ids):  # type: (Dict[str, Any], int, Dict[str, int]) -> List[str]
    errors = []  # type: List[str]
    label = _node_label(node, pos)

    kind = node.get("kind")
    if kind not in KINDS:
        errors.append("%s, поле kind: ожидается одно из %s, получено %r" % (label, "/".join(KINDS), kind))
        kind = None

    status = node.get("status")
    if status not in STATUSES:
        errors.append("%s, поле status: ожидается одно из %s, получено %r"
                      % (label, "/".join(STATUSES), status))
        status = None

    if kind == "open" and status in ("accepted", "rejected"):
        errors.append("%s, поле status: для kind=open допустимы только proposed/superseded — "
                      "открытый вопрос нельзя принять или отвергнуть, только ответить" % label)

    superseded_by = node.get("superseded_by")
    node_id = node.get("id")
    if superseded_by is not None:
        if not _is_str(superseded_by) or not superseded_by:
            errors.append("%s, поле superseded_by: ожидается id узла или null" % label)
        elif superseded_by == node_id:
            errors.append("%s, поле superseded_by: узел не может заменять сам себя" % label)
        elif superseded_by not in ids:
            errors.append("%s, поле superseded_by: узла %s нет в карте" % (label, superseded_by))
        if status is not None and status != "superseded":
            errors.append("%s, поле status: указан superseded_by, но статус %s, а не superseded"
                          % (label, status))
    elif status == "superseded":
        errors.append("%s, поле superseded_by: статус superseded, но не указано, чем заменён" % label)

    for field in _TEXT_FIELDS:
        value = node.get(field)
        if value is not None and not _is_str(value):
            errors.append("%s, поле %s: ожидается строка" % (label, field))

    # Required text per kind. `open` is a question without an answer: decision must stay empty.
    if kind is not None:
        if not _text(node.get("question")):
            errors.append("%s, поле question: обязательно для kind=%s" % (label, kind))
        if kind in ("decision", "tacit"):
            if not _text(node.get("decision")):
                errors.append("%s, поле decision: обязательно для kind=%s" % (label, kind))
            if not _text(node.get("why")):
                errors.append("%s, поле why: обязательно для kind=%s" % (label, kind))
        elif kind == "open" and _text(node.get("decision")):
            errors.append("%s, поле decision: для kind=open должно быть пустым — "
                          "если ответ есть, это decision, а не open" % label)

    against = node.get("against")
    if against is not None:
        if not isinstance(against, list):
            errors.append("%s, поле against: ожидается список строк" % label)
        else:
            for i, item in enumerate(against):
                if not _is_str(item):
                    errors.append("%s, поле against[%d]: ожидается строка" % (label, i))

    cites = node.get("cites")
    if cites is None:
        cites = []
    if not isinstance(cites, list):
        errors.append("%s, поле cites: ожидается список" % label)
    else:
        if kind in ("decision", "tacit") and not cites:
            # Exception: a decision node with hand_edited: true AND decided_by: "user" may have no cites
            decided_by = node.get("decided_by")
            hand_edited = node.get("hand_edited")
            if not (kind == "decision" and hand_edited is True and decided_by == "user"):
                errors.append("%s, поле cites: обязательно для kind=%s — без цитаты узел не проверить"
                              % (label, kind))
        for i, cite in enumerate(cites):
            errors.extend(_validate_cite(cite, i, label))

    hand_edited = node.get("hand_edited")
    if hand_edited is not None and not isinstance(hand_edited, bool):
        errors.append("%s, поле hand_edited: ожидается true/false" % label)

    added_at = node.get("added_at")
    if added_at is not None and not _is_str(added_at):
        errors.append("%s, поле added_at: ожидается строка (ISO-8601) или null" % label)

    decided_by = node.get("decided_by")
    if decided_by is not None:
        if decided_by not in DECIDERS:
            errors.append("%s, поле decided_by: ожидается user/agent или null, получено %r" % (label, decided_by))
        elif kind is not None and kind != "decision":
            errors.append("%s, поле decided_by: только у решений, а это kind=%s" % (label, kind))

    triage = node.get("triage")
    if triage is not None:
        if triage not in TRIAGES:
            errors.append("%s, поле triage: ожидается одно из %s или null, получено %r"
                          % (label, "/".join(TRIAGES), triage))
        elif status is not None and status not in _TRIAGE_STATUSES:
            errors.append("%s, поле triage: под вопросом может быть только proposed, а статус %s"
                          % (label, status))

    seen_at = node.get("seen_at")
    if seen_at is not None and not _is_str(seen_at):
        errors.append("%s, поле seen_at: ожидается строка (ISO-8601) или null" % label)

    errors.extend(_validate_relates(node, pos, ids, label))
    return errors


def _validate_relates(node, pos, ids, label):  # type: (Dict[str, Any], int, Dict[str, int], str) -> List[str]
    """Check `relates`: closed vocabulary, existing target, backward-only, at most three.

    Backward-only is checked by list position: the target must sit earlier than the node.
    That alone rules out cycles, so there is no separate cycle pass here.
    """
    errors = []  # type: List[str]
    relates = node.get("relates")
    if relates is None:
        return errors
    if not isinstance(relates, list):
        return ["%s, поле relates: ожидается список объектов {\"to\": ..., \"rel\": ...}" % label]
    if len(relates) > MAX_RELATES:
        errors.append("%s, поле relates: не более трёх связей на узел, найдено %d"
                      % (label, len(relates)))
    node_id = node.get("id")
    for i, rel in enumerate(relates):
        where = "%s, поле relates[%d]" % (label, i)
        if not isinstance(rel, dict):
            errors.append("%s: ожидался объект {\"to\": ..., \"rel\": ...}" % where)
            continue
        target = rel.get("to")
        kind = rel.get("rel")
        if kind not in RELS:
            errors.append("%s.rel: ожидается одно из %s, получено %r" % (where, "/".join(RELS), kind))
        if not _is_str(target) or not target:
            errors.append("%s.to: ожидается id узла (непустая строка)" % where)
            continue
        if target == node_id:
            errors.append("%s.to: узел %s ссылается сам на себя" % (where, node_id))
            continue
        if target not in ids:
            errors.append("%s.to: узла %s нет в карте" % (where, target))
            continue
        if ids[target] > pos:
            errors.append("%s.to: ссылка вперёд на %s — связи указывают только на узлы выше по списку"
                          % (where, target))
    return errors


def _validate_cite(cite, i, label):  # type: (Any, int, str) -> List[str]
    errors = []  # type: List[str]
    prefix = "%s, поле cites[%d]" % (label, i)
    if not isinstance(cite, dict):
        return ["%s: ожидался объект {\"quote\": ...}" % prefix]
    # The quote is the citation. A bare turn number is a guess (see docs/spec.md R4).
    if not _text(cite.get("quote")):
        errors.append("%s.quote: обязательна дословная цитата (непустая строка)" % prefix)
    turn = cite.get("turn")
    if turn is not None and (isinstance(turn, bool) or not isinstance(turn, int) or turn < 1):
        errors.append("%s.turn: ожидается целое число от 1 или null" % prefix)
    role = cite.get("role")
    if role is not None and role not in ROLES:
        errors.append("%s.role: ожидается user/assistant или null" % prefix)
    return errors


def _text(value):  # type: (Any) -> bool
    return _is_str(value) and bool(value.strip())


def _validate_supersede_chains(nodes, ids):  # type: (List[Any], Dict[str, int]) -> List[str]
    """Report every node that sits on a cycle of `superseded_by` links."""
    links = {}  # type: Dict[str, str]
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        target = node.get("superseded_by")
        if _is_str(node_id) and node_id in ids and _is_str(target) and target in ids and target != node_id:
            links[node_id] = target

    errors = []  # type: List[str]
    for start in links:
        seen = set()  # type: set
        current = start
        while current in links and current not in seen:
            seen.add(current)
            current = links[current]
        if current == start:
            errors.append("узел %s, поле superseded_by: цикл замен (%s)"
                          % (start, " -> ".join(list(seen) + [start])))
    return errors


def warnings(map_dict):  # type: (Any) -> List[str]
    """Non-blocking remarks: the map is valid, but something is worth fixing.

    Today: a node id mentioned in prose with no edge to it — prose is invisible to the
    structure, so the reader misses whatever it does not link — and an `open` node with no
    `orphaned_by` edge: the viewer files it under «просто висит» (U8), which is only true
    when no decision caused it, and the checker cannot read `why` to tell a skipped step
    from an honest «ничего не осиротило». Unlike validate() after normalize(), this never
    mutates its argument.
    """
    out = []  # type: List[str]
    nodes = map_dict.get("nodes") if isinstance(map_dict, dict) else None
    if not isinstance(nodes, list):
        return out
    positions = {}  # type: Dict[str, int]
    for pos, node in enumerate(nodes, 1):
        if isinstance(node, dict) and _is_str(node.get("id")) and node["id"] not in positions:
            positions[node["id"]] = pos

    # An edge lives on one end only (`relates` on the later node, `superseded_by` on the
    # earlier), so coverage is map-wide: a mention counts as linked if the unordered pair
    # {mentioner, mentioned} carries an edge in either direction.
    linked = set()  # type: set
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        targets = [r.get("to") for r in (node.get("relates") or []) if isinstance(r, dict)]
        targets.append(node.get("superseded_by"))
        for target in targets:
            if _is_str(target) and target and target != node_id:
                linked.add(frozenset((node_id, target)))

    for pos, node in enumerate(nodes, 1):
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        mentioned = set()  # type: set
        for field in _PROSE_FIELDS:
            value = node.get(field)
            if not _is_str(value):
                continue
            for found in _PROSE_ID_RE.findall(value):
                if found in positions and found != node_id:
                    mentioned.add(found)
        label = _node_label(node, pos)
        if node.get("kind") == "open" and not any(
                isinstance(r, dict) and r.get("rel") == "orphaned_by"
                for r in (node.get("relates") or [])):
            out.append("%s: открытый вопрос без orphaned_by — укажите решение или скажите в why, что его нет"
                       % label)
        if node.get("decided_by") == "user" and not any(
                isinstance(c, dict) and c.get("role") == "user" for c in (node.get("cites") or [])):
            out.append("%s: заявлено решение пользователя, но среди цитат нет его слов" % label)
        for missing in sorted(mentioned):
            if frozenset((node_id, missing)) in linked:
                continue
            if positions[missing] > pos:
                # The direction rule (U3) means this node cannot carry the edge itself: either
                # the later node depends on this one and carries it, or this one rests on the
                # later node and the later node belongs above it in the list.
                out.append("%s: в тексте упомянут %s, но связи нет — %s ниже по списку: "
                           "связь ставится на нём, или %s поднимается выше"
                           % (label, missing, missing, missing))
            else:
                out.append("%s: в тексте упомянут %s, но связи на него нет" % (label, missing))
    return out


def normalize(map_dict):  # type: (Any) -> Dict[str, Any]
    """Fill defaults in place and return the map.

    Does not repair errors: `version`, `id`, `kind`, `status` are never invented, so
    validate() still reports them. Non-dict nodes and cites are left untouched.
    """
    if not isinstance(map_dict, dict) or not map_dict:
        # Nothing to preserve: an absent/corrupt file loads as a valid empty map.
        map_dict = empty_map()
    for field in ("session_id", "generated_at", "title"):
        if map_dict.get(field) is None:
            map_dict[field] = ""
    nodes = map_dict.get("nodes")
    if not isinstance(nodes, list):
        nodes = []
        map_dict["nodes"] = nodes
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node.setdefault("superseded_by", None)
        if node.get("hand_edited") is None:
            node["hand_edited"] = False
        for field in _TEXT_FIELDS:
            if node.get(field) is None:
                node[field] = ""
        for field in _LIST_FIELDS:
            if node.get(field) is None:
                node[field] = []
        if node.get("added_at") is None:
            node["added_at"] = ""
        for field in ("decided_by", "triage", "seen_at"):
            node.setdefault(field, None)
        relates = node.get("relates")
        if relates is None:
            relates = []
            node["relates"] = relates
        if isinstance(relates, list):
            for rel in relates:
                if isinstance(rel, dict):
                    if rel.get("to") is None:
                        rel["to"] = ""
                    if rel.get("rel") is None:
                        rel["rel"] = ""
        cites = node.get("cites")
        if isinstance(cites, list):
            for cite in cites:
                if isinstance(cite, dict):
                    cite.setdefault("turn", None)
                    cite.setdefault("role", None)
                    if cite.get("quote") is None:
                        cite["quote"] = ""
    return map_dict


def empty_map(session_id="", title=""):  # type: (str, str) -> Dict[str, Any]
    """A valid, empty map — what a missing or corrupt file loads as."""
    return {
        "version": VERSION,
        "session_id": session_id or "",
        "generated_at": "",
        "title": title or "",
        "nodes": [],
    }
