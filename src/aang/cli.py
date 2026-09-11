"""Command line: `aang view | check | export | merge`. Entry point is `main(argv)`.

`merge` is the only path that writes a regenerated map into `.aang/map.json`: the model
writes `.aang/candidate.json`, `merge` resolves its citations to turn numbers, folds it
into the stored map through `store.merge` (hand edits survive — R6), validates, saves.
`check` is the command a human trusts: it exits 1 when the map is invalid or any
citation fails to resolve.
"""

import argparse
import os
import sys
from typing import Any, Dict, List, Optional

from . import schema, server, store

MARK_OK = "✓"
MARK_BAD = "✗"


def main(argv=None, stdout=None, stderr=None):  # type: (Optional[List[str]], Any, Any) -> int
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    parser = _parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help(out)
        return 2
    try:
        return args.func(args, out, err)
    except KeyboardInterrupt:
        return 130


def _parser():  # type: () -> argparse.ArgumentParser
    parser = argparse.ArgumentParser(
        prog="aang",
        description="Проверяемая карта того, что решила сессия Claude Code.")
    sub = parser.add_subparsers(dest="command")

    def common(p, transcript=True):  # type: (argparse.ArgumentParser, bool) -> None
        p.add_argument("--root", default=".", help="корень проекта, где лежит .aang/ (по умолчанию: .)")
        if transcript:
            p.add_argument("--session", default=None, help="id сессии; по умолчанию берётся из карты")
            p.add_argument("--transcript", default=None, help="путь к JSONL транскрипта (минуя поиск)")
            p.add_argument("--transcript-root", action="append", default=None, dest="transcript_roots",
                           help="где искать транскрипты (по умолчанию ~/.claude/projects)")

    p_view = sub.add_parser("view", help="запустить локальный сервер и напечатать URL")
    common(p_view)
    p_view.add_argument("--port", type=int, default=server.DEFAULT_PORT)
    p_view.add_argument("--verbose", action="store_true", help="логировать запросы")
    p_view.set_defaults(func=cmd_view)

    p_check = sub.add_parser("check", help="проверить карту и каждую цитату; код 1, если что-то не так")
    common(p_check)
    p_check.set_defaults(func=cmd_check)

    p_export = sub.add_parser("export", help="записать Markdown-запись решений")
    common(p_export)
    p_export.add_argument("--out", default=os.path.join("docs", "decisions.md"))
    p_export.set_defaults(func=cmd_export)

    p_merge = sub.add_parser("merge", help="влить .aang/candidate.json в .aang/map.json, сохранив правки")
    common(p_merge)
    p_merge.add_argument("--candidate", default=None, help="путь к кандидату (по умолчанию .aang/candidate.json)")
    p_merge.add_argument("--keep", action="store_true", help="не удалять кандидата после слияния")
    p_merge.set_defaults(func=cmd_merge)
    return parser


def _source(args):  # type: (argparse.Namespace) -> server.TranscriptSource
    return server.TranscriptSource(path=args.transcript, session_id=args.session,
                                   roots=args.transcript_roots)


# ----------------------------------------------------------------------------- view

def cmd_view(args, out, err):  # type: (argparse.Namespace, Any, Any) -> int
    root = os.path.abspath(args.root)
    try:
        srv = server.make_server(root, args.port, _source(args), verbose=args.verbose)
    except OSError as exc:
        err.write("Не удалось занять порт %d: %s\n" % (args.port, exc))
        return 1
    out.write("aang: карта %s\n" % store.map_path(root))
    out.write("aang: %s  (Ctrl-C — остановить)\n" % srv.url)
    out.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


# ----------------------------------------------------------------------------- check

def cmd_check(args, out, err):  # type: (argparse.Namespace, Any, Any) -> int
    root = os.path.abspath(args.root)
    path = store.map_path(root)
    if not os.path.isfile(path):
        err.write("Карты нет: %s\n" % path)
        return 1
    raw = store.read_json(path)
    if raw is None:
        err.write("Карта не читается как JSON-объект: %s\n" % path)
        return 1
    map_dict = schema.normalize(raw)
    errors = schema.validate(map_dict)
    if errors:
        out.write("Карта %s невалидна (%d ошибок):\n" % (path, len(errors)))
        for error in errors:
            out.write("  %s %s\n" % (MARK_BAD, error))
        return 1

    source = _source(args)
    turns, transcript_error = source.turns(map_dict.get("session_id") or None)
    view = server.annotate(map_dict, turns, transcript_error, source.path)
    out.write("Карта: %s\n" % path)
    if transcript_error:
        out.write("Транскрипт: %s\n" % transcript_error)
    else:
        out.write("Транскрипт: %s (%d ходов)\n" % (source.path, len(turns)))
    failed = _print_nodes(view["nodes"], out)
    total_cites = sum(len(n["cites"]) for n in view["nodes"])
    out.write("\nУзлов: %d, цитат: %d, не подтверждено: %d\n"
              % (len(view["nodes"]), total_cites, failed))
    if transcript_error:
        out.write("Итог: %s карта не проверена — транскрипт недоступен\n" % MARK_BAD)
        return 1
    if failed:
        out.write("Итог: %s карта не подтверждена — исправьте или удалите узлы с ненайденными цитатами\n"
                  % MARK_BAD)
        return 1
    out.write("Итог: %s каждая цитата найдена в транскрипте\n" % MARK_OK)
    return 0


def _print_nodes(nodes, out):  # type: (List[Dict[str, Any]], Any) -> int
    failed = 0
    for node in nodes:
        mark = MARK_OK if node["verified"] else MARK_BAD
        status = node["status"]
        if node.get("superseded_by"):
            status += " → %s" % node["superseded_by"]
        out.write("\n%s %s [%s, %s] %s\n" % (mark, node["id"], node["kind"], status,
                                              _clip(node.get("question"), 90)))
        if node.get("decision"):
            out.write("    %s\n" % _clip(node["decision"], 100))
        if not node["cites"]:
            out.write("    – нет цитат: узел нельзя проверить\n")
        for cite in node["cites"]:
            where = "ход %s" % cite["turn"] if cite["turn"] is not None else "ход ?"
            if cite.get("role"):
                where += "/" + cite["role"]
            if cite["ok"]:
                note = "  (%s)" % cite["reason"] if cite["reason"] else ""
                out.write("    %s %s «%s»%s\n" % (MARK_OK, where, _clip(cite["quote"], 70), note))
            else:
                failed += 1
                out.write("    %s %s «%s»\n        %s\n"
                          % (MARK_BAD, where, _clip(cite["quote"], 70), cite["reason"]))
    return failed


def _clip(text, limit):  # type: (Any, int) -> str
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


# ----------------------------------------------------------------------------- export

def cmd_export(args, out, err):  # type: (argparse.Namespace, Any, Any) -> int
    root = os.path.abspath(args.root)
    map_dict = store.load(root)
    errors = schema.validate(map_dict)
    if errors:
        err.write("Карта невалидна, экспорт отменён — сначала `aang check`:\n")
        for error in errors:
            err.write("  %s %s\n" % (MARK_BAD, error))
        return 1
    source = _source(args)
    turns, transcript_error = source.turns(map_dict.get("session_id") or None)
    view = server.annotate(map_dict, turns, transcript_error, source.path)
    text = store.export_markdown(view, transcript_error)
    out_path = args.out if os.path.isabs(args.out) else os.path.join(root, args.out)
    directory = os.path.dirname(out_path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(text)
    unverified = sum(1 for n in view["nodes"] if not n["verified"])
    out.write("Записано: %s (%d узлов" % (out_path, len(view["nodes"])))
    if unverified:
        out.write(", не проверено: %d — помечены в документе" % unverified)
    out.write(")\n")
    return 0


# ----------------------------------------------------------------------------- merge

def cmd_merge(args, out, err):  # type: (argparse.Namespace, Any, Any) -> int
    root = os.path.abspath(args.root)
    cand_path = args.candidate or store.candidate_path(root)
    if not os.path.isfile(cand_path):
        err.write("Кандидата нет: %s\nМодель должна записать карту в этот файл, затем `aang merge`.\n"
                  % cand_path)
        return 1
    raw = store.read_json(cand_path)
    if raw is None:
        err.write("Кандидат не читается как JSON-объект: %s\nНичего не слито.\n" % cand_path)
        return 1
    candidate = schema.normalize(raw)
    errors = schema.validate(candidate)
    if errors:
        err.write("Кандидат %s невалиден (%d ошибок), ничего не слито:\n" % (cand_path, len(errors)))
        for error in errors:
            err.write("  %s %s\n" % (MARK_BAD, error))
        return 1

    # Turn numbers come from the transcript, never from the model.
    source = _source(args)
    turns, transcript_error = source.turns(candidate.get("session_id") or None)
    if transcript_error:
        out.write("Транскрипт: %s — цитаты не проверены, ходы не проставлены\n" % transcript_error)
    resolved = store.fill_turns(candidate, turns)
    if not candidate.get("session_id") and source.path:
        candidate["session_id"] = os.path.splitext(os.path.basename(source.path))[0]

    old = store.load(root)
    old_errors = schema.validate(old)
    merged = store.merge(old, candidate)
    errors = schema.validate(merged)
    if errors:
        err.write("Результат слияния невалиден, карта не сохранена:\n")
        for error in errors:
            err.write("  %s %s\n" % (MARK_BAD, error))
        if old_errors:
            err.write("Причина, скорее всего, в текущей карте %s:\n" % store.map_path(root))
            for error in old_errors:
                err.write("  %s %s\n" % (MARK_BAD, error))
        return 1
    try:
        path = store.save(root, merged)
    except OSError as exc:
        err.write("Не удалось сохранить карту: %s\n" % exc)
        return 1

    old_ids = set(n["id"] for n in old["nodes"] if isinstance(n, dict))
    new_ids = set(n["id"] for n in candidate["nodes"])
    kept = [n["id"] for n in merged["nodes"] if n["hand_edited"]]
    added = [n["id"] for n in merged["nodes"] if n["id"] not in old_ids]
    dropped = sorted(old_ids - set(n["id"] for n in merged["nodes"]))
    missed = [r for r in resolved if not r["ok"]]

    out.write("Сохранено: %s\n" % path)
    out.write("Узлов: %d (новых: %d, сохранено правок: %d, убрано: %d)\n"
              % (len(merged["nodes"]), len(added), len(kept), len(dropped)))
    if kept:
        out.write("  правки сохранены: %s\n" % ", ".join(kept))
    if dropped:
        out.write("  убраны (нет в кандидате и не правились): %s\n" % ", ".join(dropped))
    ignored = sorted(new_ids & set(kept))
    if ignored:
        out.write("  кандидат не тронул правленные: %s\n" % ", ".join(ignored))
    out.write("Цитат: %d, найдено: %d, не найдено: %d\n"
              % (len(resolved), len(resolved) - len(missed), len(missed)))
    for miss in missed:
        out.write("  %s %s: «%s» — %s\n"
                  % (MARK_BAD, miss["node_id"], _clip(miss["quote"], 70), miss["reason"]))
    if missed:
        out.write("Ненайденные цитаты сохранены с turn: null — узлы будут показаны как непроверенные.\n")

    if not args.keep:
        try:
            os.unlink(cand_path)
        except OSError:
            pass
    return 0
