import { spawn } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { project } from "./config.ts";
import { worktreeNameError } from "./names.ts";
import { taskStore, withTaskLock, type Task, type TaskStore } from "./tasks.ts";

const gitTimeoutMs = 30_000;
const maxGitBytes = 100_000;
const maxGitText = 5000;

type GitResult = { ok: boolean; output: string };

export type WorktreeEntry = { branch?: string };

function clip(output: string): string {
  return output.length > maxGitText ? output.slice(0, maxGitText) : output;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let settled = false;
    const finish = (ok: boolean, output: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = output.trim() || "(no output)";
      resolvePromise({ ok, output: text });
    };
    const take = (chunk: Buffer) => {
      if (size >= maxGitBytes) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      const room = maxGitBytes - size;
      if (chunk.length > room) {
        overflow = true;
        chunks.push(chunk.subarray(0, room));
        size = maxGitBytes;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, "TimeoutExpired: git timed out");
    }, gitTimeoutMs);
    child.once("error", (error) => finish(false, `${error.name}: ${error.message}`));
    child.once("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      finish(code === 0 && !overflow, overflow ? `${output}\n(output truncated)` : output);
    });
  });
}

export function parseWorktreeList(output: string): Map<string, WorktreeEntry> {
  const entries = new Map<string, WorktreeEntry>();
  let current: Record<string, string> = {};
  const flush = () => {
    const raw = current.worktree;
    if (raw) entries.set(resolve(raw), { branch: current.branch });
    current = {};
  };
  for (const line of `${output}\n`.split("\n")) {
    if (!line) {
      flush();
      continue;
    }
    const space = line.indexOf(" ");
    if (space === -1) current[line] = "";
    else current[line.slice(0, space)] = line.slice(space + 1);
  }
  return entries;
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return resolve(path);
  }
}

function worktreePath(root: string, name: string): string {
  const base = resolve(root, ".worktrees");
  const path = resolve(base, name);
  const rel = relative(base, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) {
    throw new Error(`Worktree path escapes directory: ${JSON.stringify(name)}`);
  }
  return path;
}

function branchName(name: string): string {
  return `wt/${name}`;
}

async function registered(root: string): Promise<{ entries: Map<string, WorktreeEntry>; error: string | null }> {
  const listed = await runGit(["worktree", "list", "--porcelain"], root);
  if (!listed.ok) return { entries: new Map(), error: `cannot read Git worktree registry: ${clip(listed.output)}` };
  const entries = new Map<string, WorktreeEntry>();
  for (const [path, entry] of parseWorktreeList(listed.output)) {
    entries.set(await canonical(path), entry);
  }
  return { entries, error: null };
}

// A missing worktree uses the repository root. A broken binding fails closed.
export async function resolveTaskCwd(
  task: { worktree: string | null },
  root: string,
): Promise<{ cwd: string; error: string | null }> {
  if (!task.worktree) return { cwd: root, error: null };
  const nameError = worktreeNameError(task.worktree);
  if (nameError) return { cwd: root, error: nameError };
  let path: string;
  try {
    path = worktreePath(root, task.worktree);
  } catch (error) {
    return { cwd: root, error: error instanceof Error ? error.message : String(error) };
  }
  const listing = await registered(root);
  if (listing.error) return { cwd: root, error: listing.error };
  const canonicalPath = await canonical(path);
  const entry = listing.entries.get(canonicalPath);
  if (!entry) return { cwd: root, error: `worktree '${task.worktree}' is not registered with Git` };
  try {
    if (!(await stat(canonicalPath)).isDirectory()) {
      return { cwd: root, error: `worktree '${task.worktree}' is missing at ${canonicalPath}` };
    }
  } catch (error) {
    if (isEnoent(error)) {
      return { cwd: root, error: `worktree '${task.worktree}' is missing at ${canonicalPath}` };
    }
    throw error;
  }
  const expected = `refs/heads/${branchName(task.worktree)}`;
  if (entry.branch !== expected) {
    return {
      cwd: root,
      error: `worktree '${task.worktree}' is not registered on expected branch '${branchName(task.worktree)}'`,
    };
  }
  return { cwd: canonicalPath, error: null };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export async function createWorktree(
  name: string,
  taskId: string,
  root = project,
  tasks: TaskStore = taskStore,
): Promise<string> {
  const nameError = worktreeNameError(name);
  if (nameError) return `Error: ${nameError}`;
  let path: string;
  try {
    path = worktreePath(root, name);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const branch = branchName(name);
  return withTaskLock(async () => {
    let task: Task;
    try {
      task = await tasks.load(taskId);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (task.status !== "pending" || task.owner !== null) {
      return `Error: Task ${taskId} must be pending and unowned`;
    }
    if (task.worktree) return `Error: Task ${taskId} already uses worktree '${task.worktree}'`;
    if ((await tasks.list()).some((item) => item.id !== task.id && item.worktree === name)) {
      return `Error: Worktree '${name}' is already bound to another task`;
    }
    if (await exists(path)) return `Error: Worktree path already exists: ${path}`;

    const top = await runGit(["rev-parse", "--show-toplevel"], root);
    if (!top.ok || await canonical(top.output) !== await canonical(root)) {
      return "Error: Working directory must be the root of a Git repository";
    }
    const format = await runGit(["check-ref-format", "--branch", branch], root);
    if (!format.ok) return `Error: Invalid worktree branch '${branch}': ${clip(format.output)}`;
    const branchExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
    if (branchExists.ok) return `Error: Branch '${branch}' already exists`;
    const listing = await registered(root);
    if (listing.error) return `Error: ${listing.error}`;
    if (listing.entries.has(await canonical(path))) {
      return `Error: Worktree path is already registered: ${path}`;
    }

    await mkdir(resolve(root, ".worktrees"), { recursive: true });
    const added = await runGit(["worktree", "add", "-b", branch, path, "HEAD"], root);
    if (!added.ok) {
      const after = await registered(root);
      const branchNow = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
      const artifacts: string[] = [];
      if (await exists(path)) artifacts.push(`checkout path '${path}'`);
      if (after.error === null && after.entries.has(await canonical(path))) artifacts.push("registered Git worktree");
      if (branchNow.ok) artifacts.push(`branch '${branch}'`);
      if (artifacts.length > 0) {
        return "Partial operation: git worktree add reported an error after leaving "
          + `${artifacts.join(", ")}. Task ${taskId} remains unbound and no Git data was deleted. `
          + `Run \`git worktree list\`, inspect '${path}' and '${branch}', then keep or remove those `
          + `artifacts manually after preserving any work. Git error: ${clip(added.output)}`;
      }
      return `Git error: ${clip(added.output)}`;
    }

    try {
      await tasks.bindWorktree(taskId, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Partial success: Worktree '${name}' was created at ${path} on branch '${branch}', `
        + `but task binding failed: ${message}. Git data was retained for manual recovery.`;
    }
    const created = await canonical(path);
    process.stderr.write(`  \x1b[33m[worktree] created: ${name} at ${created}\x1b[0m\n`);
    return `Worktree '${name}' created at ${created} for task ${taskId}`;
  });
}

export async function removeWorktree(
  name: string,
  discardChanges = false,
  root = project,
  tasks: TaskStore = taskStore,
  leasedOwners: (path: string) => readonly string[] = () => [],
): Promise<string> {
  const nameError = worktreeNameError(name);
  if (nameError) return `Error: ${nameError}`;
  const branch = branchName(name);
  return withTaskLock(async () => {
    const listing = await registered(root);
    if (listing.error) return `Error: ${listing.error}`;
    let path: string;
    try {
      path = await canonical(worktreePath(root, name));
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    const entry = listing.entries.get(path);
    if (!entry) return `Error: worktree '${name}' is not registered with Git`;
    if (entry.branch !== `refs/heads/${branch}`) {
      return `Error: worktree '${name}' is not registered on expected branch '${branch}'`;
    }
    try {
      if (!(await stat(path)).isDirectory()) return `Error: worktree '${name}' is missing at ${path}`;
    } catch (error) {
      if (isEnoent(error)) return `Error: worktree '${name}' is missing at ${path}`;
      throw error;
    }
    const bound = (await tasks.list()).filter((task) => task.worktree === name);
    if (bound.length === 0) return `Error: Worktree '${name}' is not bound to a task`;
    const active = bound.find((task) => task.status !== "completed");
    if (active) {
      return `Error: Worktree '${name}' is bound to active task ${active.id}; complete it before removal`;
    }
    const leased = leasedOwners(path);
    if (leased.length > 0) {
      return `Error: Worktree '${name}' is still in use by ${[...leased].sort().join(", ")}; wait for the turn to end`;
    }
    const status = await runGit(["status", "--porcelain", "--ignored"], path);
    if (!status.ok) return `Error: Cannot verify worktree '${name}' status: ${clip(status.output)}`;
    if (status.output !== "(no output)" && !discardChanges) {
      const changed = status.output.split("\n").filter((line) => line.trim()).length;
      return `Error: Worktree '${name}' has ${changed} uncommitted change(s); preserve or discard them manually`;
    }
    const args = ["worktree", "remove"];
    if (discardChanges) args.push("--force");
    args.push(path);
    const removed = await runGit(args, root);
    if (!removed.ok) return `Git error: ${clip(removed.output)}`;
    try {
      for (const task of bound) await tasks.clearWorktree(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Partial success: Worktree '${name}' was removed and branch '${branch}' retained, `
        + `but task unbinding failed: ${message}. Manual recovery is required.`;
    }
    process.stderr.write(`  [worktree] removed: ${name}; branch retained\n`);
    return `Worktree '${name}' removed; branch '${branch}' retained`;
  });
}
