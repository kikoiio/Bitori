"""Fixture receipts stand in for an authenticated executor, NOT JSON signatures."""

import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from evaluation.RSI.verifier import REQUIRED_CHECKS, verify


SOURCE = "src/agent/runner.ts"
NEW_TEST = "tests/unit/agent/runner.rsi.test.ts"
BINDINGS = ("experiment_id", "base_sha", "head_sha", "verifier_sha", "config_sha256", "policy_sha256")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def receipt(manifest, name, **extra):
    return {**{key: manifest[key] for key in BINDINGS}, "name": name, "status": "passed",
            "source": "trusted_execution", "verified": True, "scope": "merge",
            "evidence_sha256": digest(name), **extra}


def freeze(manifest, checks=(), comparison=None):
    manifest["policy_sha256"] = digest(manifest["verifier_policy"])
    manifest["config_sha256"] = digest(manifest["config"])
    for row in [*checks, *([comparison] if comparison else [])]:
        row.update({key: manifest[key] for key in BINDINGS})


def fixture(kind="bugfix"):
    manifest = {"experiment_id": "fixture", "base_sha": "a" * 40, "head_sha": "b" * 40,
                "verifier_sha": "c" * 40, "config": {"environment": "offline-fixture", "model": "fake"},
                "changed_paths": sorted([SOURCE, NEW_TEST]),
                "verifier_policy": {"required_checks": sorted(REQUIRED_CHECKS | {"regression", "reproduction"}),
                                    "allowed_paths": [SOURCE, NEW_TEST], "new_test_paths": [NEW_TEST],
                                    "objective": {"kind": "bugfix", "regression_check": "regression",
                                                  "reproduction_check": "reproduction",
                                                  "reproduction_test_sha256": digest("trusted test")}}}
    if kind != "bugfix":
        manifest["verifier_policy"]["objective"] = {
            "kind": kind, "regression_check": "regression", "pair_ids": ["task-a", "task-b"],
            "min_pairs": 2, "min_improvement": 0.05,
            "max_regression": {"reliability": 0, "score": 0, "cost": 0}}
    freeze(manifest)
    checks = [receipt(manifest, name) for name in manifest["verifier_policy"]["required_checks"]]
    indexed = {check["name"]: check for check in checks}
    indexed["scope"]["details"] = {"changed_paths": manifest["changed_paths"].copy(), "new_test_paths": [NEW_TEST]}
    indexed["regression"].update(kind="trusted_regression", test_revision=manifest["verifier_sha"])
    indexed["reproduction"].update(kind="reproduction", test_revision=manifest["verifier_sha"],
                                    test_sha256=digest("trusted test"), details={
        "baseline": {"sha": manifest["base_sha"], "config_sha256": manifest["config_sha256"],
                     "status": "failed", "failure_kind": "assertion", "evidence_sha256": digest("baseline assertion")},
        "candidate": {"sha": manifest["head_sha"], "config_sha256": manifest["config_sha256"],
                      "status": "passed", "evidence_sha256": digest("candidate passes")}})
    comparison = None
    if kind != "bugfix":
        pairs = []
        for pair_id in manifest["verifier_policy"]["objective"]["pair_ids"]:
            pair = {"pair_id": pair_id}
            for arm, sha, reliability, score, cost in (("baseline", manifest["base_sha"], 0.5, 0.5, 10),
                                                       ("candidate", manifest["head_sha"], 1, 1, 8)):
                pair[arm] = {"sha": sha, "config_sha256": manifest["config_sha256"], "status": "completed",
                             "evidence_sha256": digest(pair_id + arm), "reliability": reliability,
                             "score": score, "cost": cost}
            pairs.append(pair)
        comparison = receipt(manifest, "comparison", paired=True, complete=True, stable=True, pairs=pairs)
    return manifest, checks, comparison


class VerifierTests(unittest.TestCase):
    def check_verdict(self, expected, manifest, checks, comparison=None, changed_paths=None):
        result = verify(manifest, checks, comparison,
                        manifest.get("changed_paths") if changed_paths is None else changed_paths)
        self.assertEqual(result["verdict"], expected, result["evidence"])
        self.assertFalse(result["merge_authorized"])
        self.assertTrue(result["human_review_required"])
        return result

    def test_passed_bugfix_is_review_only_and_function_is_pure(self):
        manifest, checks, comparison = fixture()
        before = copy.deepcopy((manifest, checks, comparison))
        result = self.check_verdict("passed", manifest, checks)
        self.assertFalse(result["human_reviewed"])
        for key in BINDINGS:
            self.assertEqual(result[key], manifest[key])
        self.assertEqual((manifest, checks, comparison), before)
        result["checks"][0]["status"] = "failed"
        self.assertEqual(checks[0]["status"], "passed")
        manifest["human_reviewed"] = True
        self.assertTrue(self.check_verdict("passed", manifest, checks)["human_reviewed"])

    def test_missing_and_short_manifest_identities_fail_closed(self):
        for key in BINDINGS:
            for value in (None, "", "abc", "unknown"):
                manifest, checks, _ = fixture()
                manifest[key] = value
                with self.subTest(key=key, value=value):
                    self.check_verdict("inconclusive", manifest, checks)
        manifest, checks, _ = fixture()
        del manifest["head_sha"]
        self.check_verdict("inconclusive", manifest, checks)

    def test_sha256_git_object_format_is_supported(self):
        manifest, checks, _ = fixture()
        for key, char in (("base_sha", "a"), ("head_sha", "b"), ("verifier_sha", "c")):
            manifest[key] = char * 64
        freeze(manifest, checks)
        indexed = {c["name"]: c for c in checks}
        for name in ("regression", "reproduction"):
            indexed[name]["test_revision"] = manifest["verifier_sha"]
        for arm, sha in (("baseline", "base_sha"), ("candidate", "head_sha")):
            indexed["reproduction"]["details"][arm]["sha"] = manifest[sha]
        self.check_verdict("passed", manifest, checks)

    def test_missing_or_stale_check_bindings_are_inconclusive(self):
        for key in (*BINDINGS, "evidence_sha256"):
            for value in (None, "stale"):
                manifest, checks, _ = fixture()
                checks[0][key] = value
                with self.subTest(key=key, value=value):
                    self.check_verdict("inconclusive", manifest, checks)
        for key in ("base_sha", "head_sha", "verifier_sha"):
            manifest, checks, _ = fixture()
            checks[0][key] = "d" * 40
            self.check_verdict("inconclusive", manifest, checks)

    def test_failures_missing_cancelled_unverified_and_duplicate_checks(self):
        for status, expected in (("failed", "failed"), ("inconclusive", "inconclusive"),
                                 ("cancelled", "inconclusive"), ("pending", "inconclusive"),
                                 ("timed_out", "inconclusive"), (None, "inconclusive")):
            manifest, checks, _ = fixture()
            checks[0]["status"] = status
            with self.subTest(status=status):
                self.check_verdict(expected, manifest, checks)
        manifest, checks, _ = fixture()
        self.check_verdict("inconclusive", manifest, checks[1:])
        self.check_verdict("inconclusive", manifest, checks + [checks[0]])
        for field, value in (("verified", False), ("verified", "true"), ("verified", None),
                             ("source", "candidate"), ("source", "llm"), ("source", None),
                             ("generated_by", "candidate"), ("generated_by", "llm"),
                             ("complete", False), ("stable", False), ("budget_exhausted", True),
                             ("cancelled", True)):
            manifest, checks, _ = fixture()
            checks[0][field] = value
            with self.subTest(field=field, value=value):
                self.check_verdict("inconclusive", manifest, checks)

    def test_only_smoke_cannot_be_merge_proof(self):
        manifest, checks, _ = fixture()
        for check in checks:
            check["scope"] = "smoke"
        self.check_verdict("inconclusive", manifest, checks)
        manifest, checks, _ = fixture()
        manifest["scope"] = "smoke"
        self.check_verdict("inconclusive", manifest, checks)

    def test_immutable_policy_and_configuration_hashes(self):
        manifest, checks, _ = fixture()
        manifest["verifier_policy"]["required_checks"].remove("security")
        self.check_verdict("inconclusive", manifest, checks)
        freeze(manifest, checks)
        self.check_verdict("inconclusive", manifest, checks)  # Even a rehashed weakened policy cannot pass.
        manifest, checks, _ = fixture()
        manifest["config"]["model"] = "different"
        self.check_verdict("inconclusive", manifest, checks)
        freeze(manifest)  # Old receipts must not survive a new configuration.
        self.check_verdict("inconclusive", manifest, checks)

    def test_protected_unnamed_empty_and_duplicate_paths(self):
        for paths in ([], [SOURCE, SOURCE], ["src/tools/permission-engine.ts"], ["src/toolresult/budget.ts"],
                      ["evaluation/RSI/verifier.py"], ["src/agent/../../escape.ts"],
                      ["src/agent/unlisted.ts"], ["tests/unit/agent/runner.test.ts"]):
            manifest, checks, _ = fixture()
            with self.subTest(paths=paths):
                self.check_verdict("failed", manifest, checks, changed_paths=paths)
        manifest, checks, _ = fixture()
        manifest["verifier_policy"]["allowed_paths"].append("src/tools/executor.ts")
        freeze(manifest, checks)
        self.check_verdict("failed", manifest, checks)

    def test_scope_requires_trusted_attestation_of_new_tests(self):
        manifest, checks, _ = fixture()
        scope = next(c for c in checks if c["name"] == "scope")
        scope["details"]["new_test_paths"] = []
        self.check_verdict("inconclusive", manifest, checks)
        scope["details"]["new_test_paths"] = [NEW_TEST]
        scope["details"]["changed_paths"] = [SOURCE]
        self.check_verdict("inconclusive", manifest, checks)

    def test_build_only_and_missing_objective_do_not_prove_improvement(self):
        manifest, checks, _ = fixture()
        self.check_verdict("inconclusive", manifest, [c for c in checks if c["name"] == "build"])
        del manifest["verifier_policy"]["objective"]
        freeze(manifest, checks)
        self.check_verdict("inconclusive", manifest, checks)

    def test_bugfix_requires_assertion_failure_and_candidate_pass(self):
        cases = [("baseline", "status", "passed", "failed"),
                 ("baseline", "failure_kind", "infrastructure", "inconclusive"),
                 ("baseline", "failure_kind", "timeout", "inconclusive"),
                 ("baseline", "status", "cancelled", "inconclusive"),
                 ("candidate", "status", "failed", "failed"),
                 ("candidate", "status", "inconclusive", "inconclusive"),
                 ("candidate", "sha", "d" * 40, "inconclusive"),
                 ("baseline", "evidence_sha256", None, "inconclusive"),
                 ("candidate", "config_sha256", digest("different"), "inconclusive")]
        for arm, field, value, expected in cases:
            manifest, checks, _ = fixture()
            next(c for c in checks if c["name"] == "reproduction")["details"][arm][field] = value
            with self.subTest(arm=arm, field=field, value=value):
                self.check_verdict(expected, manifest, checks)

    def test_candidate_tests_cannot_replace_frozen_trusted_regressions(self):
        for name, field, value in (("regression", "kind", "candidate_unit"),
                                   ("regression", "test_revision", "b" * 40),
                                   ("reproduction", "test_sha256", digest("candidate test")),
                                   ("reproduction", "test_revision", "b" * 40)):
            manifest, checks, _ = fixture()
            next(c for c in checks if c["name"] == name)[field] = value
            with self.subTest(name=name, field=field):
                self.check_verdict("inconclusive", manifest, checks)

    def test_unchanged_commit_fails(self):
        manifest, checks, _ = fixture()
        manifest["head_sha"] = manifest["base_sha"]
        self.check_verdict("failed", manifest, checks)

    def test_all_optimization_objectives_require_paired_improvement(self):
        for kind in ("reliability", "score", "cost"):
            manifest, checks, comparison = fixture(kind)
            with self.subTest(kind=kind):
                self.check_verdict("passed", manifest, checks, comparison)
                for pair in comparison["pairs"]:
                    pair["candidate"][kind] = pair["baseline"][kind]
                self.check_verdict("failed", manifest, checks, comparison)

    def test_missing_stale_unverified_unpaired_or_unstable_comparisons(self):
        for field, value in (("base_sha", "d" * 40), ("head_sha", None),
                             ("config_sha256", digest("wrong config")), ("verified", False),
                             ("source", "candidate"), ("scope", "smoke"), ("paired", False),
                             ("complete", False), ("stable", False), ("status", "cancelled")):
            manifest, checks, comparison = fixture("score")
            comparison[field] = value
            with self.subTest(field=field):
                self.check_verdict("inconclusive", manifest, checks, comparison)
        manifest, checks, _ = fixture("score")
        self.check_verdict("inconclusive", manifest, checks)

    def test_pair_set_and_measurements_cannot_be_cherry_picked(self):
        for mutation in (lambda c: c["pairs"].pop(),
                         lambda c: c["pairs"].append(c["pairs"][0]),
                         lambda c: c["pairs"][0].update(pair_id="unfrozen"),
                         lambda c: c["pairs"][1].update(pair_id="task-a"),
                         lambda c: c["pairs"][0]["candidate"].update(cost=None),
                         lambda c: c["pairs"][0]["candidate"].update(score=float("nan")),
                         lambda c: c["pairs"][0]["candidate"].update(reliability=True),
                         lambda c: c["pairs"][0]["candidate"].update(status="infrastructure_error"),
                         lambda c: c["pairs"][0]["baseline"].update(config_sha256=digest("different"))):
            manifest, checks, comparison = fixture("reliability")
            mutation(comparison)
            self.check_verdict("inconclusive", manifest, checks, comparison)

    def test_regressions_and_frozen_improvement_thresholds(self):
        manifest, checks, comparison = fixture("score")
        comparison["pairs"][0]["candidate"]["cost"] = 100
        self.check_verdict("failed", manifest, checks, comparison)
        manifest, checks, comparison = fixture("score")
        manifest["verifier_policy"]["objective"]["min_improvement"] = 0.75
        freeze(manifest, checks, comparison)
        self.check_verdict("failed", manifest, checks, comparison)
        manifest["verifier_policy"]["objective"]["min_improvement"] = 0
        freeze(manifest, checks, comparison)
        self.check_verdict("inconclusive", manifest, checks, comparison)

    def test_single_pair_is_smoke_even_with_positive_measurements(self):
        manifest, checks, comparison = fixture("score")
        manifest["verifier_policy"]["objective"].update(pair_ids=["task-a"], min_pairs=1)
        comparison["pairs"] = comparison["pairs"][:1]
        freeze(manifest, checks, comparison)
        self.check_verdict("inconclusive", manifest, checks, comparison)

    def test_malformed_json_shapes_never_authorize_pass(self):
        for manifest, checks, paths in ((None, [], []), ({}, None, None), ([], "bad", [SOURCE])):
            self.assertEqual(verify(manifest, checks, None, paths)["verdict"], "inconclusive")
        for field in ("status", "name", "scope", "source"):
            manifest, checks, _ = fixture()
            checks[0][field] = {"not": "a string"}
            self.check_verdict("inconclusive", manifest, checks)

    def test_cli_validates_inputs_and_exclusively_writes_local_decision(self):
        script = Path(__file__).resolve().parents[1] / "RSI/verifier.py"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            manifest, checks, comparison = fixture("cost")
            for name, value in (("manifest", manifest), ("checks", checks), ("comparison", comparison)):
                (root / f"{name}.json").write_text(json.dumps(value), encoding="utf-8")
            output = root / "decision.json"
            command = [sys.executable, "-B", str(script), "--manifest", str(root / "manifest.json"),
                       "--checks", str(root / "checks.json"), "--comparison", str(root / "comparison.json"),
                       "--output", str(output)]
            run = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            report = json.loads(output.read_text())
            self.assertEqual(report["verdict"], "passed")
            self.assertTrue(report["decision_only"])
            self.assertFalse(report["merge_authorized"])
            contents = output.read_bytes()
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 2)
            self.assertEqual(output.read_bytes(), contents)
            output.unlink()
            (root / "checks.json").write_text('{"wrong":"shape"}', encoding="utf-8")
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 2)
            self.assertFalse(output.exists())
            (root / "checks.json").write_text('[{"name":"a","name":"b"}]', encoding="utf-8")
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 2)
            (root / "checks.json").write_text('[NaN]', encoding="utf-8")
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 2)
            (root / "checks.json").write_text('[]', encoding="utf-8")
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 2)
            self.assertEqual(json.loads(output.read_text())["verdict"], "inconclusive")


if __name__ == "__main__":
    unittest.main()
