"""Focused control-plane tests; Git writes happen only in temporary repositories."""

import difflib
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch as mock_patch

from evaluation.RSI.candidate import apply_candidate, create_candidate


SOURCE = "src/agent/runner.ts"
OTHER = "src/prompt/builder.ts"
NEW_TEST = "tests/unit/agent/runner.rsi.test.ts"
BEFORE = "export const retries = 1;\n"
AFTER = "export const retries = 2;\n"


def patch_for(path=SOURCE, before=BEFORE, after=AFTER):
    new = before is None
    return (f"diff --git a/{path} b/{path}\n" + ("new file mode 100644\n" if new else "")
            + "".join(difflib.unified_diff((before or "").splitlines(True), after.splitlines(True),
                                         fromfile="/dev/null" if new else "a/" + path,
                                         tofile="b/" + path)))


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo, self.worktree = self.root / "repo", self.root / "candidate"
        self.repo.mkdir()
        identity = {"GIT_AUTHOR_NAME": "RSI Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
                    "GIT_COMMITTER_NAME": "RSI Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}
        self.env_patch = mock_patch.dict(os.environ, identity)
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        self.git("init", "-b", "main")
        for path, text in ((SOURCE, BEFORE), (OTHER, BEFORE),
                           ("src/tools/permission-engine.ts", BEFORE),
                           ("tests/unit/agent/runner.test.ts", "trusted test\n"), ("tracked.txt", "original\n")):
            self.write(self.repo / path, text)
        self.git("add", "--", "src", "tests", "tracked.txt")
        self.git("commit", "-m", "Initial fixture")
        self.base = self.git("rev-parse", "HEAD")

    @staticmethod
    def write(path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def git(self, *args, repo=None):
        return subprocess.run(["git", "-C", str(repo or self.repo), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True).stdout.strip()

    def create(self, **kwargs):
        values = dict(repo=self.repo, worktree=self.worktree, base_sha=self.base,
                      experiment_id="experiment", candidate_id="candidate")
        values.update(kwargs)
        return create_candidate(**values)

    def test_create_and_exact_resume(self):
        candidate = self.create()
        self.assertEqual(candidate["branch"], "rsi/experiment/candidate")
        self.assertEqual(candidate["base_sha"], self.base)
        self.assertEqual(candidate["worktree"], str(self.worktree))
        self.assertTrue((self.worktree / ".git").is_file())
        self.assertEqual(self.create(), candidate)
        self.assertEqual(self.git("symbolic-ref", "--short", "HEAD"), "main")

    def test_commit_only_named_files_and_preserve_all_user_dirt(self):
        self.write(self.repo / "tracked.txt", "staged user content\n")
        self.git("add", "--", "tracked.txt")
        self.write(self.repo / SOURCE, "unstaged user content\n")
        for path in (".bitori/state", "HOME/secret", "node_modules/dependency", "loose.txt"):
            self.write(self.repo / path, "user state\n")
        status = self.git("status", "--porcelain")
        staged = self.git("diff", "--cached")
        unstaged = self.git("diff")
        candidate = self.create()
        for path in (".bitori", "HOME", "node_modules", "loose.txt"):
            self.assertFalse((self.worktree / path).exists())
        text = patch_for() + patch_for(NEW_TEST, None, "export const regression = true;\n")
        result = apply_candidate(candidate, text, [SOURCE, NEW_TEST])
        self.assertNotEqual(result["head_sha"], self.base)
        self.assertEqual(len(result["head_sha"]), 40)
        self.assertEqual(result["changed_paths"], sorted([SOURCE, NEW_TEST]))
        self.assertEqual(result["patch_sha256"], hashlib.sha256(text.encode()).hexdigest())
        self.assertEqual(self.git("show", "--pretty=", "--name-only", result["head_sha"]).splitlines(),
                         sorted([SOURCE, NEW_TEST]))
        self.assertEqual((self.worktree / SOURCE).read_text(), AFTER)
        self.assertEqual(self.git("status", "--porcelain"), status)
        self.assertEqual(self.git("diff", "--cached"), staged)
        self.assertEqual(self.git("diff"), unstaged)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.base)
        self.assertEqual(self.create(), result)

    def test_unowned_branch_collision_is_not_adopted(self):
        self.git("branch", "rsi/experiment/candidate", self.base)
        with self.assertRaisesRegex(ValueError, "collision"):
            self.create()
        self.assertEqual(self.git("rev-parse", "rsi/experiment/candidate"), self.base)
        self.assertFalse(self.worktree.exists())

    def test_unowned_worktree_directory_is_preserved(self):
        self.worktree.mkdir()
        self.write(self.worktree / "owned-by-user", "keep\n")
        with self.assertRaisesRegex(ValueError, "collision"):
            self.create()
        self.assertEqual((self.worktree / "owned-by-user").read_text(), "keep\n")

    def test_owned_collision_requires_exact_worktree_and_base(self):
        self.create()
        with self.assertRaisesRegex(ValueError, "ownership collision"):
            self.create(worktree=self.root / "different")
        self.write(self.repo / "tracked.txt", "new main\n")
        self.git("add", "--", "tracked.txt")
        self.git("commit", "-m", "Advance fixture")
        with self.assertRaisesRegex(ValueError, "ownership collision"):
            self.create(base_sha=self.git("rev-parse", "HEAD"))

    def test_dirt_in_candidate_is_preserved_and_never_committed(self):
        candidate = self.create()
        self.write(self.worktree / "unrelated.txt", "private\n")
        self.git("add", "--", "unrelated.txt", repo=self.worktree)
        before = self.git("status", "--porcelain", repo=self.worktree)
        with self.assertRaisesRegex(ValueError, "existing changes"):
            apply_candidate(candidate, patch_for(), [SOURCE])
        self.assertEqual(self.git("status", "--porcelain", repo=self.worktree), before)
        self.assertEqual(self.git("rev-parse", "HEAD", repo=self.worktree), self.base)

    def test_stale_candidate_and_allowlist_changes_are_rejected(self):
        first = self.create()
        second = apply_candidate(first, patch_for(), [SOURCE, OTHER])
        with self.assertRaisesRegex(ValueError, "stale"):
            apply_candidate(first, patch_for(OTHER), [SOURCE, OTHER])
        with self.assertRaisesRegex(ValueError, "immutable"):
            apply_candidate(second, patch_for(OTHER), [OTHER])
        third = apply_candidate(second, patch_for(OTHER), [SOURCE, OTHER])
        self.assertEqual(third["changed_paths"], sorted([SOURCE, OTHER]))
        self.assertEqual(self.git("rev-list", "--count", self.base + ".." + third["head_sha"]), "2")

    def test_unrecorded_head_cannot_resume(self):
        candidate = self.create()
        self.write(self.worktree / SOURCE, AFTER)
        self.git("add", "--", SOURCE, repo=self.worktree)
        self.git("commit", "-m", "Unowned change", repo=self.worktree)
        with self.assertRaisesRegex(ValueError, "HEAD"):
            self.create()
        with self.assertRaisesRegex(ValueError, "HEAD"):
            apply_candidate(candidate, patch_for(OTHER), [OTHER])

    def test_rejects_protected_arbitrary_and_escape_paths(self):
        candidate = self.create()
        paths = ["src/tools/permission-engine.ts", "src/tools/executor.ts", "src/toolresult/budget.ts",
                 "src/agent/tool-policy.ts", "src/agent/safety-batch-scheduler.ts",
                 "src/agent/services.ts", "src/providers/factory.ts",
                 "src/tools/implementations/run-command.ts", "src/providers/secrets.ts",
                 "evaluation/RSI/verifier.py", "evaluation/results/answer.ts", ".github/workflows/ci.ts",
                 "package.json", "src/config/loader.ts", "src/agent/../../evil.ts", "/tmp/evil.ts",
                 "src/agent//evil.ts", "src/agent/.hidden.ts", "src/agent/a\\b.ts", "src/agent/*.ts",
                 "src/agent/runner.test.ts", "src/agent/__tests__/trusted.ts"]
        for path in paths:
            with self.subTest(path=path), self.assertRaises(ValueError):
                apply_candidate(candidate, patch_for(path), [path])
        self.assertEqual(self.git("status", "--porcelain", repo=self.worktree), "")

    def test_exact_allowlist_and_new_corresponding_test_required(self):
        candidate = self.create()
        cases = [(patch_for(), []), (patch_for(), [OTHER]), (patch_for(), [SOURCE, SOURCE]),
                 (patch_for("tests/unit/agent/runner.test.ts", "trusted test\n", "changed\n"),
                  [SOURCE, "tests/unit/agent/runner.test.ts"]),
                 (patch_for("tests/unit/prompt/builder.rsi.test.ts", None, "new\n"),
                  [SOURCE, "tests/unit/prompt/builder.rsi.test.ts"])]
        for text, allowed in cases:
            with self.subTest(allowed=allowed), self.assertRaises(ValueError):
                apply_candidate(candidate, text, allowed)

    def test_rejects_empty_binary_modes_renames_and_malformed_patches(self):
        candidate = self.create()
        valid = patch_for()
        cases = ["", "\n", valid + "arbitrary trailing text\n", valid + valid,
                 valid.replace("@@ -1 +1 @@", "@@ -2,9 +1 @@"),
                 valid.replace("+++ b/" + SOURCE, "+++ b/" + OTHER),
                 valid.replace("diff --git a/" + SOURCE, "diff --git a/" + OTHER),
                 valid.replace("--- a/", "old mode 100644\nnew mode 100755\n--- a/"),
                 valid.replace("--- a/", "index 1234567..abcdef0 100755\n--- a/"),
                 valid.replace("export const retries = 2;", "binary\x00text"),
                 valid.replace("\n", "\r\n"),
                 f"diff --git a/{SOURCE} b/{SOURCE}\nGIT binary patch\nliteral 5\nabc\n",
                 f"diff --git a/{SOURCE} b/{SOURCE}\ndeleted file mode 100644\n",
                 patch_for("src/agent/link.ts", None, "target\n").replace("100644", "120000"),
                 valid + patch_for(OTHER), valid[:-1]]
        for text in cases:
            with self.subTest(patch=text[:80]), self.assertRaises(ValueError):
                apply_candidate(candidate, text, [SOURCE, "src/agent/link.ts"])
        self.assertEqual(self.git("rev-parse", "HEAD", repo=self.worktree), self.base)
        self.assertEqual(self.git("status", "--porcelain", repo=self.worktree), "")

    def test_rejects_benchmark_hardcoding(self):
        candidate = self.create()
        for text in ('const id = "django__django-1234";\n', 'const data = "instance.json";\n',
                     'const path = "evaluation/results/answer";\n', 'if (instance_id === "123") {}\n'):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "hardcoding"):
                apply_candidate(candidate, patch_for(after=text), [SOURCE])

    def test_rejects_symlink_paths_and_nonregular_baseline(self):
        os.symlink("runner.ts", self.repo / "src/agent/link.ts")
        os.symlink(str(self.repo), self.root / "repo-link")
        self.git("add", "--", "src/agent/link.ts")
        self.git("commit", "-m", "Symlink fixture")
        self.base = self.git("rev-parse", "HEAD")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.create(repo=self.root / "repo-link")
        candidate = self.create()
        with self.assertRaisesRegex(ValueError, "symlink"):
            apply_candidate(candidate, patch_for("src/agent/link.ts"), ["src/agent/link.ts"])

    def test_rejects_hardlinked_candidate_file_without_touching_host_copy(self):
        candidate = self.create()
        host = self.root / "host-file.ts"
        self.write(host, BEFORE)
        (self.worktree / SOURCE).unlink()
        os.link(host, self.worktree / SOURCE)
        with self.assertRaisesRegex(ValueError, "unshared"):
            apply_candidate(candidate, patch_for(), [SOURCE])
        self.assertEqual(host.read_text(), BEFORE)
        self.assertEqual(self.git("rev-parse", "HEAD", repo=self.worktree), self.base)

    def test_rejects_executable_baseline_source(self):
        (self.repo / SOURCE).chmod(0o755)
        self.git("add", "--", SOURCE)
        self.git("commit", "-m", "Executable fixture")
        self.base = self.git("rev-parse", "HEAD")
        candidate = self.create()
        with self.assertRaisesRegex(ValueError, "non-executable"):
            apply_candidate(candidate, patch_for(), [SOURCE])

    def test_rejects_tracked_host_state(self):
        self.write(self.repo / ".bitori/quoted\nstate", "private\n")
        self.git("add", "--", ".bitori/quoted\nstate")
        self.git("commit", "-m", "Tracked host state fixture")
        with self.assertRaisesRegex(ValueError, "host state"):
            self.create(base_sha=self.git("rev-parse", "HEAD"))
        self.assertFalse(self.worktree.exists())

    def test_rejects_short_sha_bad_ids_and_nested_checkout(self):
        for kwargs in ({"base_sha": self.base[:12]}, {"candidate_id": "../escape"},
                       {"experiment_id": "bad..name"}, {"worktree": self.repo / "nested"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.create(**kwargs)

    def test_git_hook_failure_is_not_bypassed_and_leaves_evidence(self):
        candidate = self.create()
        hook = self.repo / ".git/hooks/pre-commit"
        self.write(hook, "#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "commit failed"):
            apply_candidate(candidate, patch_for(), [SOURCE])
        self.assertEqual(self.git("rev-parse", "HEAD", repo=self.worktree), self.base)
        self.assertEqual((self.worktree / SOURCE).read_text(), AFTER)
        self.assertTrue(self.git("diff", "--cached", repo=self.worktree))
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_hook_cannot_silently_change_validated_tree(self):
        candidate = self.create()
        hook = self.repo / ".git/hooks/pre-commit"
        self.write(hook, "#!/bin/sh\nprintf 'hook change\\n' > tracked.txt\ngit add -- tracked.txt\n")
        hook.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "hooks changed"):
            apply_candidate(candidate, patch_for(), [SOURCE])
        self.assertEqual(self.git("rev-parse", "HEAD"), self.base)
        with self.assertRaisesRegex(ValueError, "HEAD"):
            self.create()


if __name__ == "__main__":
    unittest.main()
