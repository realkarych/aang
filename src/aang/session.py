"""The harness side of `.aang/`: which session this map belongs to, what the viewer told
the agent, and the hook's thresholds.

`session.json` is written by `aang hook` on every event and read by `merge`, `check`,
`view` and the hook itself. `outbox.jsonl` is appended by the server on a verdict and
drained by the hook (or the manual `/aang` run). `config.json` is the human's; only
`nudge_turns` and `nudge_minutes` are read. None of these is the record — `map.json` is —
and none is committed.
"""

import datetime
import json
import os
import tempfile
from typing import Any, Dict, List, Optional

from . import store

SESSION_FILE = "session.json"
OUTBOX_FILE = "outbox.jsonl"
CONFIG_FILE = "config.json"
DEFAULT_CONFIG = {"nudge_turns": 5, "nudge_minutes": 15}


def now_iso():  # type: () -> str
    """Current UTC time as `2026-09-11T12:00:00Z` — the form the map format documents."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _path(root, name):  # type: (str, str) -> str
    return os.path.join(store.map_dir(root), name)


def find_root(start):  # type: (str) -> Optional[str]
    """Nearest directory at or above `start` that holds `.aang/map.json`."""
    current = os.path.abspath(start)
    while True:
        if os.path.isfile(store.map_path(current)):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def _write_atomic(path, payload):  # type: (str, str) -> str
    """Write `payload` to `path` through a temp file in the same directory.

    A reader (or a crash) never sees a partial file; the temp file is removed when the
    rename never happened.
    """
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".%s-" % os.path.basename(path), suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return path


def read(root):  # type: (str) -> Optional[Dict[str, Any]]
    """The session record, or None when it is absent, unreadable or not an object."""
    return store.read_json(_path(root, SESSION_FILE))


def write(root, data):  # type: (str, Dict[str, Any]) -> str
    """Replace the session record atomically and return its path."""
    return _write_atomic(_path(root, SESSION_FILE), json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def update(root, **fields):  # type: (str, **Any) -> Dict[str, Any]
    """Merge `fields` into the session record and return the result. A corrupt file starts over."""
    data = read(root) or {}
    data.update(fields)
    write(root, data)
    return data


def transcript_path(root):  # type: (str) -> Optional[str]
    """The recorded transcript path when that file still exists, else None."""
    data = read(root) or {}
    path = data.get("transcript_path")
    if isinstance(path, str) and path and os.path.isfile(path):
        return path
    return None


def outbox_append(root, kind, node_id, text, at=None):  # type: (str, str, str, str, Optional[str]) -> None
    """Append one viewer verdict for the agent to pick up."""
    path = _path(root, OUTBOX_FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    event = {"at": at or now_iso(), "kind": kind, "node": node_id, "text": text or ""}
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def outbox_read(root):  # type: (str) -> List[Dict[str, Any]]
    """Every well-formed event in the outbox, oldest first. A torn or junk line is skipped."""
    out = []  # type: List[Dict[str, Any]]
    try:
        with open(_path(root, OUTBOX_FILE), "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict) and isinstance(event.get("node"), str):
                    out.append(event)
    except OSError:
        pass
    return out


def outbox_clear(root):  # type: (str) -> None
    """Truncate the outbox once its events have been delivered. A no-op when absent."""
    path = _path(root, OUTBOX_FILE)
    if os.path.exists(path):
        with open(path, "w", encoding="utf-8"):
            pass


def config(root):  # type: (str) -> Dict[str, int]
    """`DEFAULT_CONFIG` with the positive integers `.aang/config.json` overrides."""
    out = dict(DEFAULT_CONFIG)
    data = store.read_json(_path(root, CONFIG_FILE)) or {}
    for key in DEFAULT_CONFIG:
        value = data.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            out[key] = value
    return out
