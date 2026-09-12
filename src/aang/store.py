"""Where the map lives: `<root>/.aang/map.json`, plus merge and Markdown export.

R5: the map persists as a plain file. R6: hand edits survive regeneration, which is
`merge`. Writes are atomic (temp file in the same directory, then `os.replace`), so a
crash mid-write never leaves a half-written map; an absent or corrupt file loads as an
empty map, never as an exception.

The model never writes `map.json` directly: it writes `.aang/candidate.json`, and
`aang merge` (cli.py) folds that into the map through `merge` here.

The three relation labels (`REL_LABELS`) are also carried by ui/index.html for the
viewer's chips and a test compares the two copies: change one, change both. They are
neuter because the subject is the node as a thing — «решение», «следствие» — not the
person who decided.
"""

import copy
import json
import os
import tempfile
from typing import Any, Dict, List, Optional

from . import schema, transcript, triage

MAP_DIR = ".aang"
MAP_FILE = "map.json"
CANDIDATE_FILE = "candidate.json"

CONTENT_FIELDS = ("kind", "question", "decision", "why", "against", "consequence", "cites", "relates",
                  "decided_by", "triage", "topic")

VIEW_FIELDS = ("related_by", "verified", "cell")

STAMP_FIELDS = ("added_at",)


def map_dir(root):  # type: (str) -> str
    return os.path.join(root, MAP_DIR)


def map_path(root):  # type: (str) -> str
    return os.path.join(map_dir(root), MAP_FILE)


def candidate_path(root):  # type: (str) -> str
    return os.path.join(map_dir(root), CANDIDATE_FILE)


def read_json(path):  # type: (str) -> Optional[Dict[str, Any]]
    """The JSON object in `path`, or None when the file is absent, unreadable or not an object."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def load(root):  # type: (str) -> Dict[str, Any]
    """The map at `<root>/.aang/map.json`, normalized. Absent or corrupt → an empty map."""
    return schema.normalize(read_json(map_path(root)))


def save(root, map_dict):  # type: (str, Dict[str, Any]) -> str
    """Write the map atomically and return its path.

    The content is written to a temp file in `.aang/` and renamed over `map.json`, so
    a reader (or a crash) never sees a partial file. Raises OSError when the write
    fails — a silently lost save would be worse than a loud one.
    """
    directory = map_dir(root)
    os.makedirs(directory, exist_ok=True)
    target = map_path(root)
    payload = json.dumps(map_dict, ensure_ascii=False, indent=2) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=".map-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, _mode_for(target))
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return target


def _umask():  # type: () -> int
    current = os.umask(0)
    os.umask(current)
    return current


_UMASK = _umask()


def _mode_for(target):  # type: (str) -> int
    """Keep the existing file's mode; a new file gets 0644 under the umask (mkstemp gives 0600)."""
    try:
        return os.stat(target).st_mode & 0o777
    except OSError:
        return 0o666 & ~_UMASK


def merge(old, new):  # type: (Any, Any) -> Dict[str, Any]
    """Fold a regenerated map `new` into the stored map `old` without losing human work.

    Nodes match by `id`. Rules, in order:
    - A node hand-edited in `old` keeps every content field (`CONTENT_FIELDS`: `kind`,
      `question`, `decision`, `why`, `against`, `consequence`, `cites`, `decided_by`,
      `triage`, `topic`) and stays `hand_edited`,
      whether or not `new` has a node with that id. It survives even when `new` omits it.
    - One exception, and only in the superseding direction: when `new` marks a
      hand-edited node `superseded` by a node that exists in the result and the old node
      is not superseded yet, the result records `status: superseded` and `superseded_by`.
      The human's words are untouched; what changes is the map's record that the
      conversation moved on (R2). A regeneration never un-supersedes a hand-edited node
      and never repoints its `superseded_by`.
    - A node not hand-edited in `old` is replaced by `new`'s node of the same id in full
      (kind included), and dropped when `new` omits it — that is what "regeneration of
      everything else" means.
    - Except a node already `superseded` in `old`: it is frozen, hand-edited or not. It
      survives when `new` omits it, and when `new` re-emits it, every field of the stored
      node wins — content, `status` and `superseded_by` alike. A superseded decision is
      history (R2): a regeneration that forgot it has no business retracting it (the
      next reader would find only the replacement and propose the old position again),
      one that reworded it would be editing a decision, and one that un-supersedes or
      repoints it would be rewriting the record that the conversation moved on.
    - An old node that a surviving node points at — through `superseded_by` or `relates`
      — is kept too (transitively), so the result stays valid and the record the edge
      makes stays readable. A protected node's edges are as permanent as the node, so
      their targets are pinned for the same reason; without this the candidate omitting
      a target would make the merged map invalid and refuse every merge until a human
      edited the file.
    - `relates` follows the same three classes: frozen and hand-edited nodes keep their
      edges (a regeneration that dropped them would be retracting a record), an ordinary
      node takes the candidate's edges — that is what regenerating the node means.
    - `related_by`, `verified` and `cell` (`VIEW_FIELDS`) never reach the file: they are
      derived for the view and a stored copy would be read as fact by the next reader of
      `map.json` after it had gone stale.
    - `added_at` (`STAMP_FIELDS`) is aang's own stamp: always kept from the stored node,
      never taken from a candidate. It is when the node first entered the stored map —
      the model does not know that, so a candidate's stamp is a guess and is dropped,
      like a candidate's `turn`. A node new to the map gets none here: `stamp_added_at`
      fills `added_at` right after.
    - Order: `new`'s order; old-only survivors are inserted after their nearest surviving
      old predecessor, so they keep their place in the timeline. Then, only where a kept
      edge would point forward (the candidate put a protected node above its target),
      the source is moved down below its target — see `_targets_first`.
    - A dangling `superseded_by` is not repaired here — it is possible only when `old` was
      already invalid — so `validate` reports it and the caller refuses to save.
    Top-level fields come from `new` when non-empty, else from `old`.
    Inputs are not mutated.
    """
    old = schema.normalize(copy.deepcopy(old))
    new = schema.normalize(copy.deepcopy(new))
    old_nodes = [n for n in old["nodes"] if isinstance(n, dict) and isinstance(n.get("id"), str)]
    new_nodes = [n for n in new["nodes"] if isinstance(n, dict) and isinstance(n.get("id"), str)]
    old_by_id = {}  # type: Dict[str, Dict[str, Any]]
    for node in old_nodes:
        old_by_id.setdefault(node["id"], node)

    result = []  # type: List[Dict[str, Any]]
    seen = set()  # type: set
    for incoming in new_nodes:
        node_id = incoming["id"]
        if node_id in seen:
            continue
        seen.add(node_id)
        previous = old_by_id.get(node_id)
        if previous is not None and previous.get("status") == "superseded":
            result.append(copy.deepcopy(previous))
        elif previous is not None and previous.get("hand_edited") is True:
            result.append(_merge_hand_edited(previous, incoming))
        else:
            incoming["hand_edited"] = False
            for field in STAMP_FIELDS:
                incoming[field] = previous.get(field) if previous is not None else None
            if incoming.get("added_at") is None:
                incoming["added_at"] = ""
            result.append(incoming)

    keep = set(n["id"] for n in old_nodes
               if n.get("hand_edited") is True or n.get("status") == "superseded") - seen
    keep |= _target_closure(result + [old_by_id[i] for i in keep], old_by_id, seen | keep)
    for node in old_nodes:
        node_id = node["id"]
        if node_id not in keep or node_id in seen:
            continue
        seen.add(node_id)
        result.insert(_insert_index(result, old_nodes, node_id), node)

    for node in result:
        for field in VIEW_FIELDS:
            node.pop(field, None)
    result = _targets_first(result)

    merged = {
        "version": schema.VERSION,
        "session_id": new.get("session_id") or old.get("session_id") or "",
        "generated_at": new.get("generated_at") or old.get("generated_at") or "",
        "title": new.get("title") or old.get("title") or "",
        "nodes": result,
    }
    return schema.normalize(merged)


def _merge_hand_edited(previous, incoming):  # type: (Dict[str, Any], Dict[str, Any]) -> Dict[str, Any]
    node = copy.deepcopy(previous)
    node["hand_edited"] = True
    target = incoming.get("superseded_by")
    if (incoming.get("status") == "superseded" and isinstance(target, str) and target
            and node.get("status") != "superseded" and target != node["id"]):
        node["status"] = "superseded"
        node["superseded_by"] = target
    return node


def _target_closure(nodes, old_by_id, present):
    # type: (List[Dict[str, Any]], Dict[str, Dict[str, Any]], set) -> set
    """Ids of old nodes reachable through `superseded_by` or `relates` from `nodes` and absent from `present`."""
    needed = set()  # type: set
    frontier = list(nodes)
    while frontier:
        node = frontier.pop()
        for target in _targets(node):
            if target in present or target in needed:
                continue
            if target in old_by_id:
                needed.add(target)
                frontier.append(old_by_id[target])
    return needed


def _targets(node):  # type: (Dict[str, Any]) -> List[str]
    """Every id `node` points at: its `superseded_by`, then each `relates.to`."""
    out = []  # type: List[str]
    if isinstance(node.get("superseded_by"), str):
        out.append(node["superseded_by"])
    for rel in node.get("relates") or []:
        if isinstance(rel, dict) and isinstance(rel.get("to"), str):
            out.append(rel["to"])
    return out


def _targets_first(nodes):  # type: (List[Dict[str, Any]]) -> List[Dict[str, Any]]
    """`nodes` reordered so every `relates` target precedes its source, moving as little as possible.

    The candidate's own edges point backward (it was validated), but a protected node
    keeps edges the candidate no longer orders for: put above its target, it would be a
    forward reference and the whole merge refused over an order the model chose. Taking
    the earliest node whose targets are all placed leaves an order that already works
    untouched. Nodes on a cycle (a kept edge against a candidate edge — a real conflict)
    are appended as they came, for `validate` to report. `superseded_by` may point
    forward and is not an ordering constraint.
    """
    by_id = dict((n["id"], n) for n in nodes)
    out = []  # type: List[Dict[str, Any]]
    placed = set()  # type: set
    pending = list(nodes)
    while pending:
        for i, node in enumerate(pending):
            targets = [r.get("to") for r in (node.get("relates") or []) if isinstance(r, dict)]
            if all(t in placed or t not in by_id for t in targets):
                out.append(pending.pop(i))
                placed.add(node["id"])
                break
        else:
            out.extend(pending)
            break
    return out


def _insert_index(result, old_nodes, node_id):  # type: (List[Dict[str, Any]], List[Dict[str, Any]], str) -> int
    """Position right after the nearest old predecessor of `node_id` that is in `result`."""
    positions = dict((n["id"], i) for i, n in enumerate(result))
    predecessor = None  # type: Optional[int]
    for node in old_nodes:
        if node["id"] == node_id:
            break
        if node["id"] in positions:
            predecessor = positions[node["id"]]
    return 0 if predecessor is None else predecessor + 1


def stamp_added_at(map_dict, now_iso):  # type: (Dict[str, Any], str) -> Dict[str, Any]
    """Give every node without an `added_at` the stamp `now_iso`; an existing one is kept.

    Called after `merge`, so the nodes it fills are the ones that just entered the map.
    `cmd_merge` also calls it once on a map written before `added_at` existed, before
    merging, with that map's `generated_at`: the node was present when that map was
    generated — a fact, not a reconstruction of when it really appeared — and it keeps
    that first run's own arrivals apart from the backfilled ones. Mutates and returns
    `map_dict`.
    """
    for node in map_dict.get("nodes") or []:
        if isinstance(node, dict) and not node.get("added_at"):
            node["added_at"] = now_iso
    return map_dict


def fill_turns(map_dict, turns):  # type: (Dict[str, Any], List[Dict[str, Any]]) -> List[Dict[str, Any]]
    """Set every citation's `turn` (and `role` when absent) by finding its quote in `turns`.

    A `turn` already present in the candidate is discarded first: the model cannot know
    the indexer's numbering, so in `map.json` a turn number always means "found by aang",
    never "guessed by the model". A quote that is not found keeps `turn: null` — the node
    stays in the map, and shows as unverified. Returns the resolution results, in node
    order, each extended with `node_id`.
    """
    report = []  # type: List[Dict[str, Any]]
    for node in map_dict.get("nodes") or []:
        if not isinstance(node, dict) or not isinstance(node.get("cites"), list):
            continue
        cites = [c for c in node["cites"] if isinstance(c, dict)]
        for cite in cites:
            cite["turn"] = None
        for cite, found in zip(cites, transcript.resolve(cites, turns)):
            if found["ok"]:
                cite["turn"] = found["turn"]
                if cite.get("role") is None:
                    cite["role"] = found["role"]
            found["node_id"] = node.get("id")
            report.append(found)
    return report


STATUS_RU = {"accepted": "принято", "superseded": "заменено", "proposed": "предложено",
             "rejected": "отвергнуто"}

DECIDER_RU = {"user": "вы", "agent": "агент"}
TRIAGE_RU = {"research": "ресерч", "discuss": "обсуждение"}

REL_LABELS = {
    "orphaned_by": "осиротело решением",
    "rests_on": "опирается на",
    "moots": "сделало неактуальным",
}

REL_LABELS_BACK = {
    "orphaned_by": "оставило висеть",
    "rests_on": "на этом держится",
}


def export_markdown(map_dict, transcript_error=None):  # type: (Dict[str, Any], Optional[str]) -> str
    """A decision record for humans to commit: newest first, superseded kept and marked.

    Sections are the triage cells in `triage.CELLS` order — the viewer's order, so the
    committed document and the screen read the same way — and an empty cell is omitted.
    The cell is derived here and never read off the node. "Newest" is the end of `nodes`
    — nodes are appended in conversation order. When nodes carry `verified`
    (see server.annotate), unverified ones are marked; a missing transcript is stated.
    """
    map_dict = schema.normalize(copy.deepcopy(map_dict))
    lines = []  # type: List[str]
    lines.append("# %s" % (map_dict.get("title") or "Карта решений"))
    lines.append("")
    meta = []  # type: List[str]
    if map_dict.get("session_id"):
        meta.append("Сессия: `%s`" % map_dict["session_id"])
    if map_dict.get("generated_at"):
        meta.append("Сформировано: %s" % map_dict["generated_at"])
    if meta:
        lines.append("  ".join(meta))
        lines.append("")
    if transcript_error:
        lines.append("> Цитаты не проверены: %s" % transcript_error)
        lines.append("")
    lines.append("Сформировано `aang`. Решения не редактируются: если вывод изменился, "
                 "новое решение заменяет старое, а старое остаётся здесь с пометкой «заменено».")
    lines.append("")

    nodes = [n for n in map_dict["nodes"] if isinstance(n, dict)]
    by_id = dict((n.get("id"), n) for n in nodes)
    for key, title, subtitle in triage.CELLS:
        group = [n for n in nodes if triage.cell(n) == key]
        if not group:
            continue
        lines.append("## %s" % title)
        if subtitle:
            lines.append("")
            lines.append("_%s_" % subtitle)
        lines.append("")
        for node in reversed(group):
            lines.extend(_node_markdown(node, by_id, transcript_error))
    return "\n".join(lines).rstrip("\n") + "\n"


def _node_markdown(node, by_id, transcript_error=None):
    # type: (Dict[str, Any], Dict[Any, Dict[str, Any]], Optional[str]) -> List[str]
    """One `###` section. The unverified line keeps three states apart, as the viewer
    and `check` do: nothing was searched (no transcript), nothing to search for (no
    citations), searched and not found. Only the last one may say "не найдена".

    Edges sit with the status, before the prose, both sides of each: what the node
    declares (`relates`), what was found pointing at it (`related_by`, U4) and
    `superseded_by` either way. Without the reverse side a mooted node, a depended-on one
    and an isolated one all read the same, and for an `open` node "осиротело решением d6"
    is the first thing to know. The reverse of `moots` is not a line in that list but a
    flag beside the status, because it says the node is dead. A node with nothing either
    way says so, in the viewer's words: that nothing rests on it is information too.
    """
    out = []  # type: List[str]
    cites = [c for c in (node.get("cites") or []) if isinstance(c, dict)]
    superseded = node.get("status") == "superseded"
    question = node.get("question") or "(без вопроса)"
    heading = "~~%s~~" % question if superseded else question
    out.append("### %s · %s" % (node.get("id"), heading))
    out.append("")

    relates = [r for r in (node.get("relates") or []) if isinstance(r, dict) and r.get("to")]
    related_by = [r for r in (node.get("related_by") or []) if isinstance(r, dict) and r.get("from")]
    mooted_by = [r["from"] for r in related_by if r.get("rel") == "moots"]
    replaces = [i for i, n in by_id.items()
                if node.get("id") and n.get("superseded_by") == node["id"]]

    flags = ["**Статус:** %s" % STATUS_RU.get(node.get("status"), node.get("status"))]
    if node.get("kind") == "decision" and node.get("decided_by") in DECIDER_RU:
        flags.append("**Решил:** %s" % DECIDER_RU[node["decided_by"]])
    if node.get("triage") in TRIAGE_RU:
        flags.append("**Под вопросом:** %s" % TRIAGE_RU[node["triage"]])
    if superseded and node.get("superseded_by"):
        flags.append("**Заменено:** %s" % _node_ref(node["superseded_by"], by_id))
    if mooted_by:
        flags.append("**Неактуально** — %s %s это неактуальным"
                     % (", ".join(_node_ref(i, by_id) for i in mooted_by),
                        "сделало" if len(mooted_by) == 1 else "сделали"))
    if node.get("verified") is False:
        if transcript_error:
            flags.append("**Не проверялось** — транскрипт недоступен")
        elif not cites:
            flags.append("**Нет цитат** — узел нельзя проверить")
        else:
            flags.append("**Не проверено** — цитата не найдена в транскрипте")
    if node.get("hand_edited"):
        flags.append("_исправлено вручную_")
    out.append("  ".join(flags))
    out.append("")

    edges = []  # type: List[str]
    for rel in relates:
        edges.append("%s %s" % (REL_LABELS.get(rel.get("rel"), rel.get("rel")), _node_ref(rel["to"], by_id)))
    for rel in related_by:
        if rel.get("rel") in REL_LABELS_BACK:
            edges.append("%s %s" % (REL_LABELS_BACK[rel["rel"]], _node_ref(rel["from"], by_id)))
    for node_id in replaces:
        edges.append("заменяет %s" % _node_ref(node_id, by_id))
    if edges:
        out.append("**Связи:**")
        out.append("")
        for edge in edges:
            out.append("- %s" % edge)
        out.append("")
    elif not (superseded and node.get("superseded_by")) and not mooted_by:
        out.append("**Связи:** ни с чем не связано")
        out.append("")

    if node.get("decision"):
        out.append("**Решение:** %s" % _strike(node["decision"], superseded))
        out.append("")
    if node.get("why"):
        out.append("**Почему:** %s" % node["why"])
        out.append("")
    against = [a for a in (node.get("against") or []) if isinstance(a, str) and a.strip()]
    if against:
        out.append("**Против:**")
        out.append("")
        for item in against:
            out.append("- %s" % item)
        out.append("")
    if node.get("consequence"):
        out.append("**Следствие:** %s" % node["consequence"])
        out.append("")
    if cites:
        out.append("**Цитаты:**")
        out.append("")
        for cite in cites:
            if cite.get("turn") is not None:
                where = "ход %s" % cite["turn"]
            else:
                where = "ход не указан" if transcript_error else "ход не найден"
            if cite.get("role"):
                where += ", %s" % cite["role"]
            checked = not transcript_error and cite.get("ok", True) is False
            marker = " — не подтверждена" if checked else ""
            out.append("- %s: «%s»%s" % (where, (cite.get("quote") or "").strip(), marker))
        out.append("")
    return out


def _node_ref(node_id, by_id):  # type: (str, Dict[Any, Dict[str, Any]]) -> str
    """`d6 (Какой порог?)` — an id a reader can find, with the question so they need not."""
    target = by_id.get(node_id)
    if target is not None and target.get("question"):
        return "%s (%s)" % (node_id, target["question"])
    return node_id


def _strike(text, superseded):  # type: (str, bool) -> str
    return "~~%s~~" % text if superseded else text
