import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from aang import cli, install

CMD = "/opt/aang/bin/aang"


def read_text(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


class AddHooksTest(unittest.TestCase):
    def test_adds_three_events_to_an_empty_settings(self):
        settings, added, present = install.add_hooks({}, CMD, "claude")
        self.assertEqual(["SessionStart", "UserPromptSubmit", "Stop"], added)
        self.assertEqual([], present)
        self.assertEqual("*", settings["hooks"]["SessionStart"][0]["matcher"])
        self.assertNotIn("matcher", settings["hooks"]["Stop"][0])
        self.assertEqual({"type": "command", "command": CMD + " hook", "timeout": 20},
                         settings["hooks"]["Stop"][0]["hooks"][0])

    def test_codex_entries_have_no_matcher(self):
        settings, _, _ = install.add_hooks({}, CMD, "codex")
        self.assertNotIn("matcher", settings["hooks"]["SessionStart"][0])

    def test_keeps_foreign_hooks_and_is_idempotent(self):
        foreign = {"hooks": {"SessionStart": [{"matcher": "*", "hooks": [{"type": "command", "command": "bash herdr.sh session", "timeout": 10}]}]}}
        settings, added, present = install.add_hooks(json.loads(json.dumps(foreign)), CMD, "claude")
        self.assertEqual(2, len(settings["hooks"]["SessionStart"]))
        self.assertEqual("bash herdr.sh session", settings["hooks"]["SessionStart"][0]["hooks"][0]["command"])
        again, added2, present2 = install.add_hooks(settings, "/elsewhere/aang", "claude")
        self.assertEqual(([], ["SessionStart", "UserPromptSubmit", "Stop"]), (added2, present2))
        self.assertEqual(2, len(again["hooks"]["SessionStart"]))

    def test_is_aang_hook(self):
        self.assertTrue(install.is_aang_hook({"command": "/x/bin/aang hook"}))
        self.assertTrue(install.is_aang_hook({"command": "aang hook"}))
        self.assertFalse(install.is_aang_hook({"command": "bash aang-ish.sh"}))
        self.assertFalse(install.is_aang_hook({"command": "/x/other hook"}))


class RunTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="aang-home-")
        self.addCleanup(shutil.rmtree, self.home, True)

    def test_creates_and_updates_files(self):
        os.makedirs(os.path.join(self.home, ".claude"))
        os.makedirs(os.path.join(self.home, ".codex"))
        out = io.StringIO()
        targets = install.default_targets(self.home)
        self.assertEqual(2, len(targets))
        self.assertEqual(0, install.run(targets, CMD, out))
        claude = read_json(os.path.join(self.home, ".claude", "settings.json"))
        codex = read_json(os.path.join(self.home, ".codex", "hooks.json"))
        self.assertIn("Stop", claude["hooks"]); self.assertIn("Stop", codex["hooks"])
        self.assertIn("добавлено", out.getvalue())
        out2 = io.StringIO()
        install.run(targets, CMD, out2)
        self.assertIn("уже есть", out2.getvalue())
        self.assertNotIn("добавлено", out2.getvalue())

    def test_print_only_writes_nothing(self):
        os.makedirs(os.path.join(self.home, ".claude"))
        out = io.StringIO()
        install.run(install.default_targets(self.home), CMD, out, print_only=True)
        self.assertFalse(os.path.exists(os.path.join(self.home, ".claude", "settings.json")))
        self.assertIn("\"UserPromptSubmit\"", out.getvalue())

    def test_default_targets_skip_absent_harnesses(self):
        os.makedirs(os.path.join(self.home, ".codex"))
        self.assertEqual([("codex", os.path.join(self.home, ".codex", "hooks.json"))], install.default_targets(self.home))

    def test_broken_settings_file_is_refused_not_overwritten(self):
        os.makedirs(os.path.join(self.home, ".claude"))
        path = os.path.join(self.home, ".claude", "settings.json")
        with open(path, "w") as h:
            h.write("{broken")
        out = io.StringIO()
        self.assertEqual(1, install.run([("claude", path)], CMD, out))
        self.assertEqual("{broken", read_text(path))

    def test_settings_that_are_not_an_object_are_refused(self):
        path = os.path.join(self.home, "list.json")
        with open(path, "w") as h:
            h.write("[1, 2]")
        out = io.StringIO()
        self.assertEqual(1, install.run([("claude", path)], CMD, out))
        self.assertEqual("[1, 2]", read_text(path))
        self.assertIn("не тронут", out.getvalue())

    def test_warns_when_codex_has_hooks_switched_off(self):
        os.makedirs(os.path.join(self.home, ".codex"))
        with open(os.path.join(self.home, ".codex", "config.toml"), "w") as h:
            h.write("[features]\nhooks = false\n")
        out = io.StringIO()
        install.run(install.default_targets(self.home), CMD, out)
        self.assertIn("внимание", out.getvalue())
        self.assertIn("hooks = false", out.getvalue())

    def test_codex_hooks_disabled_detection(self):
        path = os.path.join(self.home, "config.toml")
        with open(path, "w") as h:
            h.write("model = \"x\"\n[features]\nhooks = false\n[other]\nhooks = true\n")
        self.assertTrue(install.codex_hooks_disabled(path))
        with open(path, "w") as h:
            h.write("[features]\nhooks = true\n")
        self.assertFalse(install.codex_hooks_disabled(path))
        self.assertFalse(install.codex_hooks_disabled(os.path.join(self.home, "none.toml")))


class CliInstallTest(unittest.TestCase):
    """The verb, run against a temporary HOME so a real settings file is never touched."""

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="aang-home-")
        self.addCleanup(shutil.rmtree, self.home, True)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"HOME": self.home}):
            code = cli.main(list(argv), stdout=out, stderr=err)
        return code, out.getvalue(), err.getvalue()

    def test_print_writes_no_file(self):
        os.makedirs(os.path.join(self.home, ".claude"))
        code, out, err = self.run_cli("install", "--print")
        self.assertEqual(0, code, err)
        self.assertIn("\"Stop\"", out)
        self.assertFalse(os.path.exists(os.path.join(self.home, ".claude", "settings.json")))

    def test_flag_limits_the_install_to_one_harness(self):
        os.makedirs(os.path.join(self.home, ".claude"))
        os.makedirs(os.path.join(self.home, ".codex"))
        code, out, err = self.run_cli("install", "--codex")
        self.assertEqual(0, code, err)
        self.assertTrue(os.path.exists(os.path.join(self.home, ".codex", "hooks.json")))
        self.assertFalse(os.path.exists(os.path.join(self.home, ".claude", "settings.json")))

    def test_no_harness_directory_exits_1(self):
        code, out, err = self.run_cli("install")
        self.assertEqual(1, code)
        self.assertIn("устанавливать некуда", err)

    def test_command_is_the_launcher_path_only_when_it_is_aang(self):
        launcher = os.path.join(self.home, "bin", "aang")
        os.makedirs(os.path.dirname(launcher))
        open(launcher, "w").close()
        with mock.patch.object(sys, "argv", [launcher, "install"]):
            self.assertEqual(os.path.realpath(launcher), cli._aang_command())
        with mock.patch.object(sys, "argv", [os.path.join(self.home, "bin", "python3"), "install"]):
            self.assertEqual("aang", cli._aang_command())


if __name__ == "__main__":
    unittest.main()
