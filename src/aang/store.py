"""Where the map lives: `<root>/.aang/map.json`, plus merge and Markdown export.

R5: the map persists as a plain file. R6: hand edits survive regeneration, which is
`merge`. Writes are atomic (temp file in the same directory, then `os.replace`), so a
crash mid-write never leaves a half-written map; an absent or corrupt file loads as an
empty map, never as an exception.

The model never writes `map.json` directly: it writes `.aang/candidate.json`, and
`aang merge` (cli.py) folds that into the map through `merge` here.
"""

import copy
import json
import os
import tempfile
from typing import Any, Dict, List, Optional

from . import schema, transcript

MAP_DIR = ".aang"
MAP_FILE = "map.json"
CANDIDATE_FILE = "candidate.json"

# Fields a human authors. `merge` never lets a regeneration touch these on a
# hand-edited node. `status`/`superseded_by` are structural bookkeeping — see `merge`.
CONTENT_FIELDS = ("kind", "question", "decision", "why", "against", "consequence", "cites")


# ----------------------------------------------------------------------------- paths

def map_dir(root):  # type: (str) -> str
    return os.path.join(root, MAP_DIR)


def map_path(root):  # type: (str) -> str
    return os.path.join(map_dir(root), MAP_FILE)


def candidate_path(root):  # type: (str) -> str
    return os.path.join(map_dir(root), CANDIDATE_FILE)


# ----------------------------------------------------------------------------- load / save

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


# ----------------------------------------------------------------------------- merge

def merge(old, new):  # type: (Any, Any) -> Dict[str, Any]
    """Fold a regenerated map `new` into the stored map `old` without losing human work.

    Nodes match by `id`. Rules, in order:
    - A node hand-edited in `old` keeps every content field (`kind`, `question`,
      `decision`, `why`, `against`, `consequence`, `cites`) and stays `hand_edited`,
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
    - Except a node already `superseded` in `old`: it survives when `new` omits it, hand-
      edited or not. A superseded decision is history (R2), and a regeneration that
      forgot to re-emit it has no business retracting it — the next reader would find
      only the replacement and propose the old position again.
    - An old node that a surviving node points at through `superseded_by` is kept too
      (transitively), so the result stays valid and the superseded decision stays visible.
    - Order: `new`'s order; old-only survivors are inserted after their nearest surviving
      old predecessor, so they keep their place in the timeline.
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
        if previous is not None and previous.get("hand_edited") is True:
            result.append(_merge_hand_edited(previous, incoming))
        else:
            incoming["hand_edited"] = False
            result.append(incoming)

    # Old-only nodes: hand-edited and superseded ones survive; so does anything a
    # survivor supersedes into.
    keep = set(n["id"] for n in old_nodes
               if n.get("hand_edited") is True or n.get("status") == "superseded") - seen
    keep |= _supersede_closure(result + [old_by_id[i] for i in keep], old_by_id, seen | keep)
    for node in old_nodes:
        node_id = node["id"]
        if node_id not in keep or node_id in seen:
            continue
        seen.add(node_id)
        result.insert(_insert_index(result, old_nodes, node_id), node)

    # Not repaired here: a dangling `superseded_by` (possible only if `old` was already
    # invalid) is left for `validate` to report, so the caller refuses to save it.
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


def _supersede_closure(nodes, old_by_id, present):
    # type: (List[Dict[str, Any]], Dict[str, Dict[str, Any]], set) -> set
    """Ids of old nodes reachable through `superseded_by` from `nodes` and absent from `present`."""
    needed = set()  # type: set
    frontier = list(nodes)
    while frontier:
        node = frontier.pop()
        target = node.get("superseded_by")
        if not isinstance(target, str) or target in present or target in needed:
            continue
        if target in old_by_id:
            needed.add(target)
            frontier.append(old_by_id[target])
    return needed


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


# ----------------------------------------------------------------------------- turns

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


# ----------------------------------------------------------------------------- export

KIND_TITLES = (
    ("tacit", "Неявные решения", "решения, которых никто не принимал осознанно"),
    ("open", "Открытое", "вопросы и следствия, к которым никто не вернулся"),
    ("decision", "Решения", ""),
)

STATUS_RU = {"accepted": "принято", "superseded": "заменено", "proposed": "предложено"}


def export_markdown(map_dict, transcript_error=None):  # type: (Dict[str, Any], Optional[str]) -> str
    """A decision record for humans to commit: newest first, superseded kept and marked.

    Tacit and open nodes come before ordinary decisions (R3). "Newest" is the end of
    `nodes` — nodes are appended in conversation order. When nodes carry `verified`
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
    for kind, title, subtitle in KIND_TITLES:
        group = [n for n in nodes if n.get("kind") == kind]
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
    citations), searched and not found. Only the last one may say "не найдена"."""
    out = []  # type: List[str]
    cites = [c for c in (node.get("cites") or []) if isinstance(c, dict)]
    superseded = node.get("status") == "superseded"
    question = node.get("question") or "(без вопроса)"
    heading = "~~%s~~" % question if superseded else question
    out.append("### %s · %s" % (node.get("id"), heading))
    out.append("")

    flags = ["**Статус:** %s" % STATUS_RU.get(node.get("status"), node.get("status"))]
    if superseded and node.get("superseded_by"):
        target = by_id.get(node["superseded_by"])
        label = node["superseded_by"]
        if target is not None and target.get("question"):
            label += " (%s)" % target["question"]
        flags.append("**Заменено:** %s" % label)
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


def _strike(text, superseded):  # type: (str, bool) -> str
    return "~~%s~~" % text if superseded else text
