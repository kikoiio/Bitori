"""Control-plane Git candidates; worktrees are NOT execution sandboxes.

Only the trusted caller may access the repository/common Git directory. Ownership
records there are not credentials against a process with host filesystem access.
Candidate execution must never receive that directory or the worktree .git file.
"""

import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile

__all__ = ["create_candidate", "apply_candidate"]

_SHA = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
_ROOTS = {"agent", "prompt", "tools", "providers", "compact", "toolresult"}
_PROTECTED = re.compile(
    r"security|permission|approval|auth|policy|budget|limit|sandbox|gateway|"
    r"verifier|config|secret|credential|redact|control|hook|worktree|workspace-path|safety",
    re.I,
)
_CONTROL_FILES = {
    "src/agent/services.ts", "src/providers/factory.ts",
    "src/tools/executor.ts", "src/tools/create-tool-system.ts",
    "src/tools/implementations/run-command.ts", "src/tools/implementations/agent-tools.ts",
    "src/tools/implementations/team-tools.ts", "src/tools/implementations/skill-tools.ts",
}
_HARDCODING = re.compile(
    r"\b[\w.-]+__[\w.-]+-\d+\b|swe[-_ ]?bench|gold[_-]?patch|instance\.json|"
    r"solution\.patch|evaluation/results|(?:instance_?id|task_?id)\s*(?:={1,3}|:)\s*['\"]",
    re.I,
)
_MAX_PATCH = 1024 * 1024
_MAX_FILES = 32
_IDENTITY = ("repo", "worktree", "branch", "base_sha", "experiment_id", "candidate_id")


def _git(repo, *args, input=None):
    # Prevent ambient Git routing from redirecting writes. Preserve identity and
    # normal repository/global hooks and signing configuration; never override it.
    identity = {f"GIT_{who}_{field}" for who in ("AUTHOR", "COMMITTER")
                for field in ("NAME", "EMAIL", "DATE")}
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_") or k in identity}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_LITERAL_PATHSPECS="1")
    result = subprocess.run(["git", "-C", str(repo), *args], input=input,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if result.returncode:
        raise ValueError(f"git {args[0]} failed: {result.stderr.decode('utf-8', 'replace').strip()}")
    return result.stdout.decode("utf-8", "strict").strip()


def _absolute_no_links(path):
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"symlink is not allowed: {part}")
    return path


def _source_path(path):
    if not isinstance(path, str) or not re.fullmatch(r"[A-Za-z0-9_./-]+", path):
        raise ValueError("paths must be literal repository-relative names")
    parts = path.split("/")
    if any(not p or p.startswith(".") for p in parts):
        raise ValueError(f"unsafe path: {path}")
    is_test = parts[:2] == ["tests", "unit"]
    source = "src/" + path[len("tests/unit/"):] if is_test else path
    sp = source.split("/")
    if len(sp) < 3 or sp[0] != "src" or sp[1] not in _ROOTS or not source.endswith(".ts"):
        raise ValueError(f"path outside candidate source/test scope: {path}")
    if _PROTECTED.search(source) or source in _CONTROL_FILES:
        raise ValueError(f"protected control path: {path}")
    if not is_test and (source.endswith((".test.ts", ".spec.ts")) or
                        any(p in {"test", "tests", "__tests__"} for p in sp[2:])):
        raise ValueError("candidate tests must be new corresponding tests/unit files")
    if is_test and not source.endswith(".test.ts"):
        raise ValueError("new unit tests must end in .test.ts")
    # Check corresponding control filenames even for runner.rsi.test.ts style names.
    if is_test and any(source.startswith(p[:-3] + ".") for p in _CONTROL_FILES):
        raise ValueError(f"protected control test: {path}")
    return is_test


def _validate_allowlist(paths):
    if not isinstance(paths, list) or not paths or len(paths) > _MAX_FILES:
        raise ValueError("an explicit, bounded allowlist is required")
    for path in paths:
        _source_path(path)
    if len(set(paths)) != len(paths):
        raise ValueError("duplicate allowlist path")
    sources = [p for p in paths if p.startswith("src/")]
    if not sources:
        raise ValueError("allowlist must name corresponding source files")
    for path in paths:
        if path.startswith("tests/unit/"):
            stem = "src/" + path[len("tests/unit/"):-len(".test.ts")]
            if not any(stem == p[:-3] or stem.startswith(p[:-3] + ".") for p in sources):
                raise ValueError(f"unit test has no explicitly allowed source: {path}")
    return set(paths)


def _parse_patch(patch, allowed):
    """Accept a deliberately small, unambiguous subset of Git unified diffs."""
    if not isinstance(patch, str) or not patch or len(patch.encode("utf-8")) > _MAX_PATCH:
        raise ValueError("empty or oversized patch")
    if "\x00" in patch or "\r" in patch or not patch.endswith("\n"):
        raise ValueError("patch must be LF-terminated text")
    lines = patch.splitlines(keepends=True)
    files, additions, i = {}, [], 0
    while i < len(lines):
        header = re.fullmatch(r"diff --git a/(\S+) b/(\S+)\n", lines[i])
        if not header or header[1] != header[2]:
            raise ValueError("only same-path, unquoted Git diffs are allowed")
        path = header[1]
        _source_path(path)
        if path not in allowed or path in files:
            raise ValueError(f"unnamed or repeated path: {path}")
        i += 1
        new = i < len(lines) and lines[i] == "new file mode 100644\n"
        if new:
            i += 1
        if i < len(lines) and lines[i].startswith("index "):
            pattern = r"index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}" + (r"\n" if new else r" 100644\n")
            if not re.fullmatch(pattern, lines[i]):
                raise ValueError("invalid index header or non-regular file mode")
            i += 1
        old = "/dev/null" if new else "a/" + path
        if lines[i:i + 2] != [f"--- {old}\n", f"+++ b/{path}\n"]:
            raise ValueError("renames, deletions, binary patches and mode changes are forbidden")
        i += 2
        hunks, changed = 0, False
        while i < len(lines) and lines[i].startswith("@@ "):
            hunk = re.fullmatch(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n", lines[i])
            if not hunk:
                raise ValueError("malformed hunk")
            old_count, new_count = int(hunk[2] or 1), int(hunk[4] or 1)
            i += 1
            while old_count or new_count:
                if i >= len(lines) or lines[i][0] not in " +-":
                    raise ValueError("truncated or malformed hunk")
                line = lines[i]
                if line[0] in " -":
                    old_count -= 1
                if line[0] in " +":
                    new_count -= 1
                if old_count < 0 or new_count < 0:
                    raise ValueError("incorrect hunk counts")
                if line[0] != " ":
                    changed = True
                if line[0] == "+":
                    additions.append(line[1:])
                i += 1
                if i < len(lines) and lines[i] == "\\ No newline at end of file\n":
                    i += 1
            hunks += 1
        if not hunks or not changed:
            raise ValueError("empty file patch")
        files[path] = new
    if not files or len(files) > _MAX_FILES:
        raise ValueError("empty or oversized file set")
    if _HARDCODING.search("".join(additions)):
        raise ValueError("benchmark instance hardcoding or answer access is forbidden")
    return files


def _common(repo):
    return Path(_git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))


def _record_path(common, branch):
    return common / "rsi-candidates" / (hashlib.sha256(branch.encode()).hexdigest() + ".json")


@contextlib.contextmanager
def _locked(record_path):
    lock = record_path.with_suffix(".lock")
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise ValueError("candidate is busy; retained locks require trusted inspection") from exc
    try:
        os.close(fd)
        yield
    finally:
        lock.unlink()


def _persist(path, record, *, exclusive=False):
    data = (json.dumps(record, sort_keys=True) + "\n").encode()
    if exclusive:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    else:
        fd, temp = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)


def _load_record(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError("persisted candidate ownership is missing")
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError("invalid ownership record") from exc
    if not isinstance(record, dict) or record.get("version") != 1:
        raise ValueError("invalid ownership record")
    return record


def _check_checkout(record, common):
    worktree = _absolute_no_links(record["worktree"])
    if not (worktree / ".git").is_file() or (worktree / ".git").is_symlink():
        raise ValueError("candidate must be an existing linked Git worktree")
    if _common(worktree) != common or Path(_git(worktree, "rev-parse", "--show-toplevel")) != worktree:
        raise ValueError("worktree repository mismatch")
    if _git(worktree, "symbolic-ref", "HEAD") != "refs/heads/" + record["branch"]:
        raise ValueError("candidate branch mismatch")
    if _git(worktree, "rev-parse", "HEAD") != record["head_sha"]:
        raise ValueError("candidate HEAD differs from persisted ownership")
    _git(worktree, "merge-base", "--is-ancestor", record["base_sha"], record["head_sha"])
    return worktree


def create_candidate(repo: Path, worktree: Path, base_sha: str,
                     experiment_id: str, candidate_id: str) -> dict:
    """Create or exactly resume an owned rsi/<experiment>/<candidate> worktree.

    Existing branches/directories without a matching control-plane ledger are
    rejected. The caller's checkout, index, ignored state and HOME are untouched.
    A failed creation is retained for inspection, never force-cleaned or adopted.
    """
    repo, worktree = _absolute_no_links(repo), _absolute_no_links(worktree)
    if Path(_git(repo, "rev-parse", "--show-toplevel")) != repo:
        raise ValueError("repo must be the repository checkout root")
    if not isinstance(base_sha, str) or not _SHA.fullmatch(base_sha):
        raise ValueError("base_sha must be a full commit SHA")
    if _git(repo, "rev-parse", "--verify", base_sha + "^{commit}") != base_sha:
        raise ValueError("base_sha must identify a commit, not a tag")
    for value in (experiment_id, candidate_id):
        if not isinstance(value, str) or not _ID.fullmatch(value):
            raise ValueError("invalid experiment/candidate ID")
    branch = f"rsi/{experiment_id}/{candidate_id}"
    _git(repo, "check-ref-format", "refs/heads/" + branch)
    common = _absolute_no_links(_common(repo))
    if worktree == repo or repo in worktree.parents or worktree == common or common in worktree.parents:
        raise ValueError("candidate worktree must be outside the repository and Git directory")
    if not worktree.parent.is_dir():
        raise ValueError("worktree parent must already exist")
    path = _record_path(common, branch)
    _absolute_no_links(path.parent)
    path.parent.mkdir(mode=0o700, exist_ok=True)
    requested = dict(repo=str(repo), worktree=str(worktree), base_sha=base_sha,
                     experiment_id=experiment_id, candidate_id=candidate_id, branch=branch)
    with _locked(path):
        if path.exists() or path.is_symlink():
            record = _load_record(path)
            if any(record.get(k) != requested[k] for k in _IDENTITY):
                raise ValueError("candidate ownership collision")
            _check_checkout(record, common)
            return dict(record)
        branches = _git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/" + branch).splitlines()
        if branches or worktree.exists():
            raise ValueError("unowned branch or worktree collision")
        tracked = _git(repo, "ls-tree", "-r", "-z", "--name-only", base_sha).split("\0")
        if any(set(PurePosixPath(p).parts) & {".bitori", "HOME", "node_modules"} for p in tracked):
            raise ValueError("baseline tracks host state or dependencies")
        record = dict(requested, version=1, head_sha=base_sha)
        _persist(path, record, exclusive=True)
        _git(repo, "worktree", "add", "-b", branch, str(worktree), base_sha)
        _check_checkout(record, common)
        return dict(record)


def apply_candidate(candidate: dict, patch: str, allowed_paths: list[str]) -> dict:
    """Validate, apply and commit only frozen candidate paths, honoring hooks/signing.

    Rejection never resets the checkout. Hook/commit failures leave local evidence
    in the candidate worktree; the trusted caller must inspect it before retrying.
    Syntax screening is conservative, not a substitute for sandbox/security review.
    """
    allowed = _validate_allowlist(allowed_paths)
    files = _parse_patch(patch, allowed)
    if not isinstance(candidate, dict) or any(not isinstance(candidate.get(k), str) for k in _IDENTITY):
        raise ValueError("invalid candidate identity")
    repo = _absolute_no_links(candidate["repo"])
    common = _absolute_no_links(_common(repo))
    path = _record_path(common, candidate["branch"])
    _absolute_no_links(path.parent)
    with _locked(path):
        record = _load_record(path)
        if any(record.get(k) != candidate.get(k) for k in (*_IDENTITY, "head_sha")):
            raise ValueError("candidate identity or HEAD is stale")
        if "allowed_paths" in record and record["allowed_paths"] != sorted(allowed):
            raise ValueError("candidate allowlist is immutable")
        worktree = _check_checkout(record, common)
        if _git(worktree, "status", "--porcelain", "--untracked-files=normal"):
            raise ValueError("candidate has existing changes; refusing to disturb them")
        for name, new in files.items():
            target = _absolute_no_links(worktree / name)
            entry = _git(worktree, "ls-tree", record["head_sha"], "--", name)
            baseline_entry = _git(worktree, "ls-tree", record["base_sha"], "--", name)
            if name.startswith("tests/") and (not new or baseline_entry or entry):
                raise ValueError("existing trusted tests cannot be changed")
            if new:
                if entry or target.exists():
                    raise ValueError("new file already exists")
            elif (not entry.startswith("100644 blob ") or not target.is_file()
                  or target.stat().st_mode & 0o111 or target.stat().st_nlink != 1):
                raise ValueError("only regular, non-executable, unshared tracked text files may change")
        data = patch.encode("utf-8")
        _git(worktree, "apply", "--check", "--index", "--whitespace=error-all", "-", input=data)
        record["allowed_paths"] = sorted(allowed)
        _persist(path, record)
        _git(worktree, "apply", "--index", "--whitespace=error-all", "-", input=data)
        changed = sorted(_git(worktree, "diff", "--cached", "--name-only", "-z").strip("\0").split("\0"))
        if changed != sorted(files):
            raise ValueError("applied paths differ from validated patch")
        for name in changed:
            content = (worktree / name).read_text(encoding="utf-8")
            if "\x00" in content or _HARDCODING.search(content):
                raise ValueError("candidate contains binary content or benchmark hardcoding")
        expected_tree = _git(worktree, "write-tree")
        message = f"RSI {record['experiment_id']}/{record['candidate_id']}: apply candidate\n"
        _git(worktree, "commit", "--only", "--file=-", "--", *changed, input=message.encode())
        head = _git(worktree, "rev-parse", "HEAD")
        if _git(worktree, "rev-parse", "HEAD^{tree}") != expected_tree:
            raise ValueError("commit hooks changed the validated tree; candidate requires inspection")
        if _git(worktree, "rev-parse", "HEAD^") != record["head_sha"]:
            raise ValueError("candidate commit parent changed")
        cumulative = sorted(_git(worktree, "diff", "--name-only", "-z", record["base_sha"], head,
                                 "--").strip("\0").split("\0"))
        if not cumulative or cumulative == [""] or not set(cumulative).issubset(allowed):
            raise ValueError("candidate has no net change or exceeds its frozen scope")
        record.update(head_sha=head, changed_paths=cumulative, patch_sha256=hashlib.sha256(data).hexdigest())
        _persist(path, record)
        return dict(record)
