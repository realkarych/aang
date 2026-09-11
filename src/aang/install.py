"""`aang install`: register `aang hook` in the harness settings, idempotently.

Claude Code reads `~/.claude/settings.json` (`hooks.<Event>[].hooks[]`), Codex reads
`~/.codex/hooks.json` with the same shape. Foreign entries are kept; an aang entry is
recognised by its command (`… aang … hook`) so a moved checkout does not add a second one.
"""

import json
import os
import re
import tempfile
from typing import Any, Dict, List, Optional, Tuple

EVENTS = ("SessionStart", "UserPromptSubmit", "Stop")
TIMEOUT = 20
_MATCHER_EVENTS = {"claude": ("SessionStart",), "codex": ()}
"""Events whose group carries a `matcher`: Codex takes none, Claude Code one on SessionStart."""


def is_aang_hook(hook):  # type: (Any) -> bool
    """Is this one hook entry ours? Decided by the command, not by where it was installed from."""
    command = hook.get("command") if isinstance(hook, dict) else None
    return isinstance(command, str) and command.rstrip().endswith(" hook") and "aang" in command


def entry(command, harness, event):  # type: (str, str, str) -> Dict[str, Any]
    """The hook group to append for one event; `matcher` comes first where the harness wants one."""
    group = {"hooks": [{"type": "command", "command": "%s hook" % command, "timeout": TIMEOUT}]}  # type: Dict[str, Any]
    if event in _MATCHER_EVENTS.get(harness, ()):
        group = dict([("matcher", "*")] + list(group.items()))
    return group


def add_hooks(settings, command, harness):
    # type: (Dict[str, Any], str, str) -> Tuple[Dict[str, Any], List[str], List[str]]
    """Add the missing aang entries to a parsed settings object.

    Returns the settings, the events an entry was added to, and the events that already had
    one. Anything of the wrong type where the hooks map or an event list belongs is replaced:
    the harness could not have read it either.
    """
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}
        settings["hooks"] = hooks
    added, present = [], []  # type: List[str], List[str]
    for event in EVENTS:
        groups = hooks.get(event)
        if not isinstance(groups, list):
            groups = []
            hooks[event] = groups
        if any(isinstance(g, dict) and any(is_aang_hook(h) for h in (g.get("hooks") or [])) for g in groups):
            present.append(event)
            continue
        groups.append(entry(command, harness, event))
        added.append(event)
    return settings, added, present


def default_targets(home=None):  # type: (Optional[str]) -> List[Tuple[str, str]]
    """The (harness, settings path) pairs to install into: a harness whose directory exists."""
    home = home or os.path.expanduser("~")
    out = []  # type: List[Tuple[str, str]]
    if os.path.isdir(os.path.join(home, ".claude")):
        out.append(("claude", os.path.join(home, ".claude", "settings.json")))
    if os.path.isdir(os.path.join(home, ".codex")):
        out.append(("codex", os.path.join(home, ".codex", "hooks.json")))
    return out


def codex_hooks_disabled(config_toml):  # type: (str) -> bool
    """Does the Codex config say `hooks = false` under `[features]`?

    A line scan, not a TOML parser: the answer only feeds a warning, and hooks are on by
    default, so an unreadable or sectionless file means «not disabled».
    """
    try:
        with open(config_toml, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return False
    section = None
    for line in text.splitlines():
        stripped = line.strip()
        m = re.match(r"^\[([^\]]+)\]$", stripped)
        if m:
            section = m.group(1).strip()
            continue
        if section == "features" and re.match(r"^hooks\s*=\s*false\b", stripped):
            return True
    return False


def run(targets, command, out, print_only=False):  # type: (List[Tuple[str, str]], str, Any, bool) -> int
    """Install into every target and report per harness; 1 if any file was left alone.

    A settings file that does not read back as a JSON object is never written: what is in
    there is someone's configuration, and overwriting it costs more than not installing.
    The remaining targets are still done.
    """
    code = 0
    for harness, path in targets:
        settings = {}  # type: Dict[str, Any]
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    settings = json.load(handle)
            except (OSError, ValueError) as exc:
                out.write("%s: файл %s не читается как JSON (%s) — не тронут\n" % (harness, path, exc))
                code = 1
                continue
            if not isinstance(settings, dict):
                out.write("%s: файл %s — не объект JSON, не тронут\n" % (harness, path))
                code = 1
                continue
        settings, added, present = add_hooks(settings, command, harness)
        if print_only:
            out.write("%s → %s\n%s\n" % (harness, path, json.dumps(settings, ensure_ascii=False, indent=2)))
            continue
        if added:
            _write(path, settings)
        out.write("%s: %s\n" % (harness, path))
        if added:
            out.write("  добавлено: %s\n" % ", ".join(added))
        if present:
            out.write("  уже есть: %s\n" % ", ".join(present))
        if harness == "codex" and codex_hooks_disabled(os.path.join(os.path.dirname(path), "config.toml")):
            out.write("  внимание: в config.toml стоит [features] hooks = false — хуки не сработают\n")
    return code


def _write(path, settings):  # type: (str, Dict[str, Any]) -> None
    """Replace the settings file in one step, keeping its mode, so a crash cannot truncate it."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".%s-" % os.path.basename(path), suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        if os.path.exists(path):
            os.chmod(tmp, os.stat(path).st_mode & 0o777)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
