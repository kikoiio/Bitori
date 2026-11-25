import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { project } from "./config.ts";
import { worktreeNameError } from "./names.ts";

// Reads and writes yield. Reentry is per async context, so a locked method
// can call another without waiting behind itself.
const lockDepth = new AsyncLocalStorage<number>();
let lockTail: Promise<void> = Promise.resolve();

export function withTaskLock<T>(action: () => Promise<T>): Promise<T> {
  const depth = lockDepth.getStore() ?? 0;
  if (depth > 0) return lockDepth.run(depth + 1, action);
  const run = lockTail.then(() => lockDepth.run(1, action), () => lockDepth.run(1, action));
  lockTail = run.then(() => undefined, () => undefined);
  return run;
}

// IDs are generated when a task is created. Dependencies are added later,
// once every node has a real ID.
const taskIdPattern = /^task_[0-9a-f]{8}$/;
const taskFilePattern = /^task_[0-9a-f]{8}\.json$/;
const markers = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
} as const;

export type TaskId = string & { readonly __brand: "TaskId" };

type TaskBase = {
  id: TaskId;
  subject: string;
  description: string;
  blockedBy: TaskId[];
  worktree: string | null;
};

// A pending task has no owner. An active or finished task always has one.
export type Task =
  | (TaskBase & { status: "pending"; owner: null })
  | (TaskBase & { status: "in_progress"; owner: string })
  | (TaskBase & { status: "completed"; owner: string });

export type ClaimResult =
  | { ok: true; task: Extract<Task, { status: "in_progress" }> }
  | { ok: false; message: string };

export type CompleteResult =
  | { ok: true; task: Extract<Task, { status: "completed" }>; unblocked: string[] }
  | { ok: false; message: string };

class TaskDataError extends Error {}

class TaskNotFound extends Error {
  constructor(id: string) {
    super(`Task not found: ${id}`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function toTaskId(value: unknown, invalid: Error): TaskId {
  if (typeof value !== "string" || !taskIdPattern.test(value)) throw invalid;
  return value as TaskId;
}

function requireTaskId(value: string): TaskId {
  return toTaskId(value, new Error(`Invalid task ID: ${JSON.stringify(value)}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapes(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

// Resolve symlinks the way Path.resolve does, including a missing final segment.
async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return resolve(await canonical(parent), basename(absolute));
  }
}

function parseStatus(value: unknown): Task["status"] {
  if (value === "pending" || value === "in_progress" || value === "completed") return value;
  throw new TaskDataError(`Invalid task status: ${JSON.stringify(value)}`);
}

function parseBlockedBy(value: unknown, id: TaskId): TaskId[] {
  if (!Array.isArray(value)) throw new TaskDataError(`Task ${id} blockedBy must be a list.`);
  return value.map((item) => toTaskId(
    item,
    new TaskDataError(`Task ${id} has an invalid dependency.`),
  ));
}

// Older task files have no worktree field. Missing and null both mean unbound.
function parseWorktree(value: unknown, id: TaskId): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || worktreeNameError(value) !== null) {
    throw new TaskDataError(`Task ${id} has an invalid worktree.`);
  }
  return value;
}

function parseTask(data: unknown, expectedId: TaskId): Task {
  if (!isRecord(data)) throw new TaskDataError(`Task file ${expectedId} is not a JSON object.`);
  const id = toTaskId(data.id, new TaskDataError(`Task file ${expectedId} has an invalid id.`));
  if (id !== expectedId) throw new TaskDataError(`Task file ID does not match ${expectedId}`);
  if (typeof data.subject !== "string" || data.subject.trim() === "") {
    throw new TaskDataError(`Task ${id} subject must be a non-empty string.`);
  }
  if (typeof data.description !== "string") {
    throw new TaskDataError(`Task ${id} description must be a string.`);
  }
  const status = parseStatus(data.status);
  const blockedBy = parseBlockedBy(data.blockedBy, id);
  const worktree = parseWorktree(data.worktree, id);
  const subject = data.subject;
  const description = data.description;
  if (!("owner" in data)) throw new TaskDataError(`Task ${id} is missing owner.`);
  if (status === "pending") {
    if (data.owner !== null) throw new TaskDataError(`Task ${id} is pending but has an owner.`);
    return { id, subject, description, status, owner: null, blockedBy, worktree };
  }
  if (typeof data.owner !== "string" || data.owner === "") {
    throw new TaskDataError(`Task ${id} requires an owner.`);
  }
  const owner = data.owner;
  if (status === "in_progress") return { id, subject, description, status, owner, blockedBy, worktree };
  return { id, subject, description, status, owner, blockedBy, worktree };
}

export class TaskStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async #root(create: boolean): Promise<string> {
    const workspace = await canonical(project);
    const rootPath = await canonical(this.directory);
    if (escapes(workspace, rootPath)) throw new Error("Task store escapes the workspace");
    if (create) await mkdir(rootPath, { recursive: true });
    return rootPath;
  }

  async #path(taskId: TaskId, createRoot: boolean): Promise<string> {
    const rootPath = await this.#root(createRoot);
    const path = resolve(rootPath, `${taskId}.json`);
    if (escapes(rootPath, path)) throw new Error(`Invalid task ID: ${JSON.stringify(taskId)}`);
    return path;
  }

  async #read(taskId: TaskId): Promise<Task> {
    const path = await this.#path(taskId, false);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new TaskNotFound(taskId);
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new TaskDataError(`Task file ${taskId} is not valid JSON.`);
    }
    return parseTask(data, taskId);
  }

  async #save(task: Task): Promise<void> {
    const path = await this.#path(task.id, true);
    await writeFile(path, JSON.stringify(task, null, 2), "utf8");
  }

  async exists(taskId: string): Promise<boolean> {
    return withTaskLock(async () => {
      const path = await this.#path(requireTaskId(taskId), false);
      try {
        return (await stat(path)).isFile();
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
    });
  }

  async create(subject: string, description = ""): Promise<Task> {
    const trimmed = subject.trim();
    if (!trimmed) throw new Error("Task subject cannot be empty");
    return withTaskLock(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const task: Extract<Task, { status: "pending" }> = {
        id: requireTaskId(`task_${randomBytes(4).toString("hex")}`),
        subject: trimmed,
        description,
        status: "pending",
        owner: null,
        blockedBy: [],
        worktree: null,
      };
      const path = await this.#path(task.id, true);
      try {
        const handle = await open(path, "wx");
        try {
          await handle.writeFile(JSON.stringify(task, null, 2), "utf8");
        } catch (error) {
          await unlink(path).catch(() => undefined);
          throw error;
        } finally {
          await handle.close();
        }
        return task;
      } catch (error) {
        if (isErrno(error, "EEXIST")) continue;
        throw error;
      }
    }
    throw new Error("Could not allocate a unique task ID");
    });
  }

  async load(taskId: string): Promise<Task> {
    return withTaskLock(() => this.#read(requireTaskId(taskId)));
  }

  async list(): Promise<Task[]> {
    return withTaskLock(() => this.#list());
  }

  async #list(): Promise<Task[]> {
    const rootPath = await this.#root(false);
    let names: string[];
    try {
      names = await readdir(rootPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const tasks: Task[] = [];
    for (const name of names.filter((entry) => taskFilePattern.test(entry)).sort()) {
      tasks.push(await this.load(name.slice(0, -".json".length)));
    }
    return tasks;
  }

  // A missing or unreadable dependency still blocks, so a broken edge cannot be skipped.
  async #incomplete(task: Task): Promise<TaskId[]> {
    const incomplete: TaskId[] = [];
    for (const dependency of task.blockedBy) {
      try {
        if ((await this.#read(dependency)).status !== "completed") incomplete.push(dependency);
      } catch (error) {
        if (error instanceof TaskNotFound || error instanceof TaskDataError) {
          incomplete.push(dependency);
          continue;
        }
        throw error;
      }
    }
    return incomplete;
  }

  async #dependsOn(start: TaskId, target: TaskId): Promise<boolean> {
    const pending: TaskId[] = [start];
    const visited = new Set<TaskId>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(await this.#read(current)).blockedBy);
    }
    return false;
  }

  async updateDependencies(taskId: string, addBlockedBy: readonly string[]): Promise<Task> {
    return withTaskLock(async () => this.#updateDependencies(taskId, addBlockedBy));
  }

  async #updateDependencies(taskId: string, addBlockedBy: readonly string[]): Promise<Task> {
    if (!Array.isArray(addBlockedBy)) throw new Error("addBlockedBy must be a list of task IDs");
    const task = await this.load(taskId);
    if (task.status !== "pending") {
      throw new Error(
        `Task ${task.id} dependencies can only be updated while pending and unowned`,
      );
    }
    const seen = new Set<TaskId>();
    const dependencies: TaskId[] = [];
    for (const item of addBlockedBy) {
      if (typeof item !== "string") throw new Error("addBlockedBy must be a list of task IDs");
      const dependency = requireTaskId(item);
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      dependencies.push(dependency);
    }
    const blockedBy = [...task.blockedBy];
    for (const dependency of dependencies) {
      if (dependency === task.id) throw new Error("Task cannot depend on itself");
      if (!(await this.exists(dependency))) throw new Error(`Dependency not found: ${dependency}`);
      if (!task.blockedBy.includes(dependency) && await this.#dependsOn(dependency, task.id)) {
        throw new Error(`Dependency cycle detected: ${task.id} -> ${dependency}`);
      }
      if (!blockedBy.includes(dependency)) blockedBy.push(dependency);
    }
    const updated: Extract<Task, { status: "pending" }> = { ...task, blockedBy };
    await this.#save(updated);
    return updated;
  }

  async ownerInProgress(owner: string): Promise<Extract<Task, { status: "in_progress" }> | null> {
    return withTaskLock(async () => {
      const found = (await this.#list()).find((task): task is Extract<Task, { status: "in_progress" }> => (
        task.status === "in_progress" && task.owner === owner
      ));
      return found ?? null;
    });
  }

  async isReady(task: Task): Promise<boolean> {
    return withTaskLock(async () => (await this.#incomplete(task)).length === 0);
  }

  async claim(taskId: string, owner = "agent"): Promise<ClaimResult> {
    if (!owner) throw new Error("Task owner cannot be empty");
    return withTaskLock(async () => {
      const task = await this.#read(requireTaskId(taskId));
      if (task.status !== "pending") {
        return { ok: false, message: `Task ${task.id} is ${task.status}, cannot claim` };
      }
      const current = (await this.#list()).find((item) => item.status === "in_progress" && item.owner === owner);
      if (current) {
        return {
          ok: false,
          message: `Owner ${owner} must complete ${current.id} before claiming another task`,
        };
      }
      const dependencies = await this.#incomplete(task);
      if (dependencies.length > 0) {
        return { ok: false, message: `Blocked by: ${dependencies.join(", ")}` };
      }
      const claimed: Extract<Task, { status: "in_progress" }> = {
        ...task,
        status: "in_progress",
        owner,
      };
      await this.#save(claimed);
      return { ok: true, task: claimed };
    });
  }

  async complete(taskId: string, owner = "agent"): Promise<CompleteResult> {
    return withTaskLock(() => this.#complete(taskId, owner));
  }

  async #complete(taskId: string, owner: string): Promise<CompleteResult> {
    const task = await this.load(taskId);
    if (task.status !== "in_progress") {
      return { ok: false, message: `Task ${task.id} is ${task.status}, cannot complete` };
    }
    if (task.owner !== owner) {
      return {
        ok: false,
        message: `Task ${task.id} is owned by ${task.owner}, not ${owner}; cannot complete`,
      };
    }
    const readyBefore = new Set<TaskId>();
    for (const candidate of await this.list()) {
      if (
        candidate.status === "pending"
        && candidate.blockedBy.length > 0
        && (await this.#incomplete(candidate)).length === 0
      ) {
        readyBefore.add(candidate.id);
      }
    }
    const completed: Extract<Task, { status: "completed" }> = {
      ...task,
      status: "completed",
    };
    await this.#save(completed);
    const unblocked: string[] = [];
    for (const candidate of await this.list()) {
      if (
        candidate.status === "pending"
        && candidate.blockedBy.length > 0
        && !readyBefore.has(candidate.id)
        && (await this.#incomplete(candidate)).length === 0
      ) {
        unblocked.push(candidate.subject);
      }
    }
    return { ok: true, task: completed, unblocked };
  }

  // A dead teammate returns in-progress work to the board. The worktree binding stays.
  async abandon(taskId: string, owner: string): Promise<boolean> {
    return withTaskLock(async () => {
      const task = await this.#read(requireTaskId(taskId));
      if (task.status !== "in_progress" || task.owner !== owner) return false;
      const pending: Extract<Task, { status: "pending" }> = {
        ...task,
        status: "pending",
        owner: null,
      };
      await this.#save(pending);
      return true;
    });
  }

  async bindWorktree(taskId: string, name: string): Promise<Task> {
    const nameError = worktreeNameError(name);
    if (nameError) throw new Error(nameError);
    return withTaskLock(async () => {
      const task = await this.#read(requireTaskId(taskId));
      if (task.status !== "pending" || task.owner !== null) {
        throw new Error(`Task ${taskId} must be pending and unowned`);
      }
      if (task.worktree) throw new Error(`Task ${taskId} already uses worktree '${task.worktree}'`);
      const taken = (await this.#list()).find((item) => item.id !== task.id && item.worktree === name);
      if (taken) throw new Error(`Worktree '${name}' is already bound to another task`);
      const bound: Extract<Task, { status: "pending" }> = { ...task, worktree: name };
      await this.#save(bound);
      return bound;
    });
  }

  async clearWorktree(taskId: string): Promise<void> {
    return withTaskLock(async () => {
      const task = await this.#read(requireTaskId(taskId));
      await this.#save({ ...task, worktree: null });
    });
  }
}

export const taskStore = new TaskStore(resolve(project, ".tasks"));

export function formatCreated(task: Task): string {
  return `Created ${task.id}: ${task.subject}`;
}

export function formatUpdated(task: Task): string {
  return `Updated ${task.id} blockedBy: ${task.blockedBy.join(", ") || "(none)"}`;
}

export function formatTaskList(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "No tasks. Use create_task to add some.";
  return tasks.map((task) => {
    const owner = task.owner === null ? "" : ` [${task.owner}]`;
    const dependencies = task.blockedBy.length === 0
      ? ""
      : ` (blockedBy: ${task.blockedBy.join(", ")})`;
    const worktree = task.worktree === null ? "" : ` (worktree: ${task.worktree})`;
    return `${markers[task.status]} ${task.id}: ${task.subject} [${task.status}]${owner}${dependencies}${worktree}`;
  }).join("\n");
}

export function formatTask(task: Task): string {
  return JSON.stringify(task, null, 2);
}

export function formatClaim(result: ClaimResult): string {
  if (!result.ok) return result.message;
  return `Claimed ${result.task.id} (${result.task.subject})`;
}

export function formatComplete(result: CompleteResult): string {
  if (!result.ok) return result.message;
  const message = `Completed ${result.task.id} (${result.task.subject})`;
  return result.unblocked.length === 0 ? message : `${message}\nUnblocked: ${result.unblocked.join(", ")}`;
}
