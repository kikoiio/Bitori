"""Pure decision engine over CALLER-AUTHENTICATED execution receipts.

TRUST BOUNDARY: `verify` cannot authenticate JSON or execute tests. Its caller must
load an immutable manifest and receipts from a protected, pinned verifier executor,
verify artifact digests/provenance, and bind them to the actual merge target. A
`verified: true` claim from candidate/LLM JSON is NOT authentication. Never publish
a GitHub check from this CLI's output alone. No function here merges or writes Git.

Manifest schema: experiment_id, base_sha, head_sha, verifier_sha, config (object),
config_sha256, verifier_policy (object), policy_sha256. Hashes use canonical JSON
(sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).
Policy: required_checks (names including REQUIRED_CHECKS), allowed_paths,
new_test_paths, objective. Objective is either:
  {kind: bugfix, reproduction_check, regression_check, reproduction_test_sha256}
or {kind: reliability|score|cost, regression_check, pair_ids, min_pairs,
    min_improvement, max_regression: {reliability, score, cost}}.
Receipts bind all manifest identities/hashes plus name, status, evidence_sha256,
source='trusted_execution', verified=true, scope='merge'. See fixture tests for
reproduction details and paired comparison rows. All digests are mandatory; the
trusted caller, not this pure function, verifies that their artifacts really exist.
"""

import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import statistics
import sys

if __package__:
    from .candidate import _source_path, _validate_allowlist
else:
    # Direct CLI/importlib loading: use the pinned sibling control-plane module,
    # never a module named 'candidate' supplied through an unrelated sys.path.
    import importlib.util
    _scope_spec = importlib.util.spec_from_file_location("_rsi_trusted_scope", Path(__file__).with_name("candidate.py"))
    _scope_module = importlib.util.module_from_spec(_scope_spec)
    _scope_spec.loader.exec_module(_scope_module)
    _source_path, _validate_allowlist = _scope_module._source_path, _scope_module._validate_allowlist

__all__ = ["verify", "main"]
REQUIRED_CHECKS = frozenset({"scope", "build", "typecheck", "lint", "trusted_unit",
                             "integration", "security", "new_tests"})
_SHA = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_BINDINGS = ("experiment_id", "base_sha", "head_sha", "verifier_sha", "policy_sha256", "config_sha256")
_METRICS = ("reliability", "score", "cost")


class _InvalidEvidence(ValueError):
    pass


class _Failed(ValueError):
    pass


def _require(condition, message):
    if not condition:
        raise _InvalidEvidence(message)


def _sha(value, *, digest=False):
    return isinstance(value, str) and bool((_DIGEST if digest else _SHA).fullmatch(value)) and set(value) != {"0"}


def _canonical_sha256(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def _number(value, *, minimum=0):
    return type(value) in (float, int) and math.isfinite(value) and value >= minimum


def _names(value):
    return (isinstance(value, list) and all(isinstance(v, str) and v.strip() for v in value)
            and len(value) == len(set(value)))


def _validate_caller_authenticated_receipt(receipt, manifest):
    """Validate bindings, NOT provenance; authentication belongs to the caller."""
    _require(isinstance(receipt, dict), "receipt must be an object")
    for key in _BINDINGS:
        _require(receipt.get(key) == manifest[key], f"receipt has missing/stale {key}")
    _require(_sha(receipt.get("evidence_sha256"), digest=True), "missing evidence digest")
    _require(receipt.get("source") == "trusted_execution" and receipt.get("verified") is True,
             "unverified or candidate-generated evidence")
    _require(receipt.get("scope") == "merge", "smoke/development evidence is not merge proof")
    _require(receipt.get("generated_by", "trusted_executor") == "trusted_executor",
             "generated fake or LLM report is not execution evidence")
    _require(receipt.get("status") in {"passed", "failed", "inconclusive"},
             "missing/cancelled/unknown check status")
    _require(receipt.get("status") != "inconclusive", "check has inconclusive evidence")
    _require(receipt.get("complete", True) is True and receipt.get("stable", True) is True
             and receipt.get("budget_exhausted", False) is False
             and receipt.get("cancelled", False) is False,
             "execution was incomplete, unstable, cancelled or over budget")


def _regression(objective, indexed, required, manifest):
    name = objective.get("regression_check")
    _require(isinstance(name, str) and name in required, "objective must require a trusted regression check")
    receipt = indexed[name]
    _require(receipt.get("kind") == "trusted_regression" and
             receipt.get("test_revision") == manifest["verifier_sha"],
             "regression suite must come from the pinned trusted verifier")


def _bugfix(objective, indexed, required, manifest):
    name = objective.get("reproduction_check")
    _require(isinstance(name, str) and name in required, "missing required bug reproduction check")
    _require(name != objective["regression_check"], "reproduction and regression checks must be distinct")
    expected_test = objective.get("reproduction_test_sha256")
    _require(_sha(expected_test, digest=True), "reproduction test must be frozen in the policy")
    receipt = indexed[name]
    _require(receipt.get("kind") == "reproduction" and receipt.get("test_sha256") == expected_test
             and receipt.get("test_revision") == manifest["verifier_sha"],
             "reproduction must use the frozen trusted test")
    details = receipt.get("details")
    _require(isinstance(details, dict), "missing reproduction evidence")
    for arm, sha in (("baseline", manifest["base_sha"]), ("candidate", manifest["head_sha"])):
        result = details.get(arm)
        _require(isinstance(result, dict) and result.get("sha") == sha
                 and result.get("config_sha256") == manifest["config_sha256"]
                 and _sha(result.get("evidence_sha256"), digest=True), f"missing/stale {arm} reproduction")
    baseline, candidate = details["baseline"], details["candidate"]
    _require(baseline.get("status") in {"passed", "failed"}, "baseline reproduction incomplete")
    if baseline["status"] == "passed":
        raise _Failed("baseline already passes: no demonstrated bugfix")
    _require(baseline.get("failure_kind") == "assertion", "baseline failure was not an assertion")
    _require(candidate.get("status") in {"passed", "failed"}, "candidate reproduction incomplete")
    if candidate["status"] != "passed":
        raise _Failed("candidate did not fix the reproduction")
    return {"objective": "bugfix", "reproduction_check": name,
            "regression_check": objective["regression_check"], "test_sha256": expected_test}


def _paired_improvement(objective, comparison, manifest):
    _require(isinstance(comparison, dict), "paired comparison is required")
    _validate_caller_authenticated_receipt(comparison, manifest)
    if comparison["status"] == "failed":
        raise _Failed("paired comparison failed")
    _require(comparison.get("paired") is True and comparison.get("complete") is True
             and comparison.get("stable") is True, "comparison is unpaired, incomplete or unstable")
    pair_ids = objective.get("pair_ids")
    minimum = objective.get("min_pairs")
    _require(_names(pair_ids) and len(pair_ids) >= 2, "freeze at least two comparison pair IDs; one task is smoke")
    _require(type(minimum) is int and 2 <= minimum <= len(pair_ids), "invalid minimum pair count")
    improvement = objective.get("min_improvement")
    _require(_number(improvement) and improvement > 0, "minimum improvement must be positive")
    limits = objective.get("max_regression")
    _require(isinstance(limits, dict) and set(limits) == set(_METRICS)
             and all(_number(v) for v in limits.values()), "freeze all score/reliability/cost regression thresholds")
    pairs = comparison.get("pairs")
    _require(isinstance(pairs, list) and len(pairs) == len(pair_ids), "missing or extra comparison pairs")
    seen, deltas = set(), {metric: [] for metric in _METRICS}
    for pair in pairs:
        _require(isinstance(pair, dict) and isinstance(pair.get("pair_id"), str), "invalid comparison pair")
        pair_id = pair["pair_id"]
        _require(pair_id in pair_ids and pair_id not in seen, "duplicate or unfrozen comparison pair")
        seen.add(pair_id)
        for arm, sha in (("baseline", manifest["base_sha"]), ("candidate", manifest["head_sha"])):
            row = pair.get(arm)
            _require(isinstance(row, dict) and row.get("sha") == sha
                     and row.get("config_sha256") == manifest["config_sha256"]
                     and _sha(row.get("evidence_sha256"), digest=True), f"unbound {arm} comparison row")
            _require(row.get("status") == "completed", "infrastructure or incomplete comparison row")
            for metric in _METRICS:
                _require(_number(row.get(metric)), f"missing/invalid {metric} measurement")
                if metric != "cost":
                    _require(row[metric] <= 1, f"{metric} must be in [0, 1]")
        for metric in _METRICS:
            delta = pair["candidate"][metric] - pair["baseline"][metric]
            deltas[metric].append(-delta if metric == "cost" else delta)
    means = {metric: statistics.mean(values) for metric, values in deltas.items()}
    for metric in _METRICS:
        if means[metric] < -limits[metric]:
            raise _Failed(f"{metric} regression exceeds frozen threshold")
    kind = objective["kind"]
    if means[kind] <= 0 or means[kind] < improvement:
        raise _Failed(f"no sufficient {kind} improvement")
    return {"objective": kind, "pairs": len(pairs), "mean_improvement": means,
            "comparison_evidence_sha256": comparison["evidence_sha256"]}


def verify(manifest: dict, checks: list[dict], comparison: dict | None,
           changed_paths: list[str]) -> dict:
    """Decide from caller-authenticated inputs; pure, fail-closed, never merge.

    `passed` means eligible for independent human review, not authentication of
    these inputs or permission to merge. Missing/stale evidence is inconclusive;
    demonstrated failures, forbidden scope and absent improvement are failed.
    """
    identity = manifest if isinstance(manifest, dict) else {}
    result = {key: identity.get(key) for key in _BINDINGS}
    result.update(verdict="inconclusive", checks=copy.deepcopy(checks), evidence=[],
                  human_review_required=True, human_reviewed=identity.get("human_reviewed") is True,
                  merge_authorized=False, decision_only=True,
                  trust_assumption="caller_authenticated_execution_receipts")
    try:
        _require(isinstance(manifest, dict), "manifest must be an object")
        _require(isinstance(manifest.get("experiment_id"), str) and
                 bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", manifest["experiment_id"])),
                 "experiment identity is missing/invalid")
        for key in ("base_sha", "head_sha", "verifier_sha"):
            _require(_sha(manifest.get(key)), f"missing or non-full {key}")
        _require(len({len(manifest[k]) for k in ("base_sha", "head_sha", "verifier_sha")}) == 1,
                 "inconsistent commit object formats")
        if manifest["base_sha"] == manifest["head_sha"]:
            raise _Failed("candidate has no new commit")
        policy, config = manifest.get("verifier_policy"), manifest.get("config")
        _require(isinstance(policy, dict) and isinstance(config, dict) and bool(config),
                 "immutable verifier policy and configuration are required")
        for key, value in (("policy_sha256", policy), ("config_sha256", config)):
            _require(_sha(manifest.get(key), digest=True) and manifest[key] == _canonical_sha256(value),
                     f"missing or mismatched {key}")
        _require(manifest.get("scope", "merge") == "merge", "smoke manifest cannot authorize merge proof")
        required = policy.get("required_checks")
        _require(_names(required) and REQUIRED_CHECKS.issubset(required),
                 "immutable policy is missing required merge checks")
        try:
            allowed = _validate_allowlist(policy.get("allowed_paths"))
            if not _names(changed_paths) or not changed_paths:
                raise ValueError("nonempty, unique changed paths are required")
            for path in changed_paths:
                _source_path(path)
                if path not in allowed:
                    raise ValueError(f"changed path is not explicitly allowed: {path}")
        except ValueError as exc:
            raise _Failed(str(exc)) from exc
        new_tests = policy.get("new_test_paths")
        _require(_names(new_tests) and set(new_tests) == {p for p in allowed if p.startswith("tests/unit/")},
                 "all allowed tests must be declared new in the immutable policy")
        _require(isinstance(checks, list), "checks must be an array")
        indexed = {}
        for check in checks:
            _validate_caller_authenticated_receipt(check, manifest)
            name = check.get("name")
            _require(isinstance(name, str) and bool(name.strip()) and name not in indexed,
                     "missing/duplicate check name")
            indexed[name] = check
        _require(set(required).issubset(indexed), "missing required checks")
        failures = [name for name, check in indexed.items() if check["status"] == "failed"]
        if failures:
            raise _Failed("failed checks: " + ", ".join(sorted(failures)))
        scope = indexed["scope"].get("details")
        _require(isinstance(scope, dict) and scope.get("changed_paths") == sorted(changed_paths)
                 and scope.get("new_test_paths") == sorted(set(changed_paths) & set(new_tests)),
                 "trusted scope check must attest exact changed paths and newly added tests")
        objective = policy.get("objective")
        _require(isinstance(objective, dict) and objective.get("kind") in {"bugfix", *_METRICS},
                 "freeze an improvement objective; build success alone is insufficient")
        _regression(objective, indexed, required, manifest)
        if objective["kind"] == "bugfix":
            if comparison is not None:
                _validate_caller_authenticated_receipt(comparison, manifest)
                _require(comparison["status"] == "passed", "supplied comparison did not pass")
            evidence = _bugfix(objective, indexed, required, manifest)
        else:
            evidence = _paired_improvement(objective, comparison, manifest)
        result["evidence"].append(evidence)
        result["verdict"] = "passed"
    except _Failed as exc:
        result["verdict"] = "failed"
        result["evidence"].append({"reason": str(exc)})
    except (_InvalidEvidence, ValueError, TypeError, KeyError, OverflowError, RecursionError) as exc:
        result["evidence"].append({"reason": str(exc) or "invalid evidence"})
    return result


def _unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError(f"duplicate JSON key: {key}")
        obj[key] = value
    return obj


def _load_json(path, expected):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError(f"input must be a bounded regular JSON file: {path}")
    def reject_constant(value):
        raise ValueError(f"nonfinite JSON number: {value}")
    value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object,
                       parse_constant=reject_constant)
    if not isinstance(value, expected):
        raise ValueError(f"unexpected JSON type: {path}")
    return value


def main(argv: list[str] | None = None) -> int:
    """Evaluate local, caller-authenticated receipts; never publish remote checks."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--checks", type=Path, required=True)
    parser.add_argument("--comparison", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        manifest = _load_json(args.manifest, dict)
        checks = _load_json(args.checks, list)
        comparison = _load_json(args.comparison, dict) if args.comparison else None
        result = verify(manifest, checks, comparison, manifest.get("changed_paths"))
        if not args.output.parent.is_dir() or args.output.is_symlink():
            raise ValueError("output parent must exist and output must not be a symlink")
        # Exclusive output prevents overwriting an input or a previously trusted report.
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(result, stream, sort_keys=True, indent=2, allow_nan=False)
            stream.write("\n")
    except (OSError, ValueError, TypeError, RecursionError) as exc:
        print(f"invalid verification input/output: {exc}", file=sys.stderr)
        return 2
    return {"passed": 0, "failed": 1, "inconclusive": 2}[result["verdict"]]


if __name__ == "__main__":
    raise SystemExit(main())
