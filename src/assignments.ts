import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { project } from "./config.ts";
import {
  formatClaim,
  formatComplete,
  taskStore,
  withTaskLock,
  type TaskStore,
} from "./tasks.ts";
import { resolveTaskCwd } from "./worktree.ts";

export const planGateValues = ["not_required", "required", "pending", "approved", "rejected"] as const;
export type PlanGate = (typeof planGateValues)[number];

const blockingGates: ReadonlySet<PlanGate> = new Set(["required", "pending", "rejected"]);

type Lease = { taskId: string; cwd: string };

// One cwd lease per owner. The lease outlives task completion until the model turn ends.
export class Assignments {
  readonly tasks: TaskStore;
  readonly root: string;
  #leases = new Map<string, Lease>();
  #versions = new Map<string, number>();
  #gates = new Map<string, PlanGate>();
  #planRequestIds = new Map<string, string>();

  constructor(tasks: TaskStore, root: string) {
    this.tasks = tasks;
    this.root = root;
  }

  exclusive<T>(action: () => Promise<T> | T): Promise<T> {
    return withTaskLock(async () => action());
  }

  prepare(name: string, requirePlan: boolean): void {
    this.#versions.set(name, 0);
    this.#gates.set(name, requirePlan ? "required" : "not_required");
    this.#planRequestIds.delete(name);
  }

  forget(name: string): void {
    this.#leases.delete(name);
    this.#versions.delete(name);
    this.#gates.delete(name);
    this.#planRequestIds.delete(name);
  }

  clearRuntime(name: string): void {
    this.#gates.delete(name);
    this.#planRequestIds.delete(name);
  }

  planGate(owner: string): PlanGate {
    return this.#gates.get(owner) ?? "not_required";
  }

  setPlanGate(owner: string, gate: PlanGate): void {
    this.#gates.set(owner, gate);
  }

  planRequestId(owner: string): string | undefined {
    return this.#planRequestIds.get(owner);
  }

  setPlanRequest(owner: string, requestId: string | undefined): void {
    if (requestId === undefined) this.#planRequestIds.delete(owner);
    else this.#planRequestIds.set(owner, requestId);
  }

  hasLease(owner: string): boolean {
    return this.#leases.has(owner);
  }

  identity(owner: string): { version: number; taskId: string | null } {
    const lease = this.#leases.get(owner);
    return {
      version: this.#versions.get(owner) ?? 0,
      taskId: lease ? lease.taskId : null,
    };
  }

  leasedOwners(path: string): string[] {
    const target = resolve(path);
    const owners: string[] = [];
    for (const [owner, lease] of this.#leases) {
      if (resolve(lease.cwd) === target) owners.push(owner);
    }
    return owners;
  }

  async claim(taskId: string, owner: string): Promise<string> {
    return withTaskLock(async () => {
      const existing = this.#leases.get(owner);
      if (existing) {
        return `Owner ${owner} must finish the current work turn for ${existing.taskId} `
          + "before claiming another task";
      }
      let task;
      try {
        task = await this.tasks.load(taskId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error: ${message}`;
      }
      if (task.status !== "pending") return `Task ${task.id} is ${task.status}, cannot claim`;
      const current = await this.tasks.ownerInProgress(owner);
      if (current) {
        return `Owner ${owner} must complete ${current.id} before claiming another task`;
      }
      const resolved = await resolveTaskCwd(task, this.root);
      if (resolved.error) return `Cannot claim ${taskId}: ${resolved.error}`;
      const result = await this.tasks.claim(taskId, owner);
      if (!result.ok) return result.message;
      this.#leases.set(owner, { taskId: result.task.id, cwd: await realpath(resolved.cwd) });
      this.#advance(owner);
      process.stderr.write(`  [claim] ${result.task.subject} -> in_progress (owner: ${owner})\n`);
      return formatClaim(result);
    });
  }

  async completeFor(owner: string, taskId: string): Promise<string> {
    return withTaskLock(async () => {
      const gate = this.planGate(owner);
      if (blockingGates.has(gate)) {
        return `Task ${taskId} cannot complete while plan status is ${gate}`;
      }
      let task;
      try {
        task = await this.tasks.load(taskId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error: ${message}`;
      }
      if (task.status !== "in_progress") return `Task ${task.id} is ${task.status}, cannot complete`;
      if (task.owner !== owner) {
        return `Task ${task.id} is owned by ${task.owner}, not ${owner}; cannot complete`;
      }
      const lease = this.#leases.get(owner);
      if (!lease || lease.taskId !== task.id) {
        const resolved = await resolveTaskCwd(task, this.root);
        if (resolved.error) return `Task ${taskId} cannot complete: ${resolved.error}`;
        this.#leases.set(owner, { taskId: task.id, cwd: await realpath(resolved.cwd) });
      }
      const result = await this.tasks.complete(taskId, owner);
      if (!result.ok) return result.message;
      process.stderr.write(`  [complete] ${result.task.subject}\n`);
      if (result.unblocked.length > 0) {
        process.stderr.write(`  [unblocked] ${result.unblocked.join(", ")}\n`);
      }
      return formatComplete(result);
    });
  }

  async workingDirectory(owner: string): Promise<string> {
    return withTaskLock(async () => {
      let lease = this.#leases.get(owner);
      const active = await this.tasks.ownerInProgress(owner);
      if (active && (!lease || lease.taskId !== active.id)) {
        const resolved = await resolveTaskCwd(active, this.root);
        if (resolved.error) throw new Error(resolved.error);
        lease = { taskId: active.id, cwd: await realpath(resolved.cwd) };
        this.#leases.set(owner, lease);
      } else if (!lease) {
        return this.root;
      }
      const task = await this.tasks.load(lease.taskId);
      if ((task.status !== "in_progress" && task.status !== "completed") || task.owner !== owner) {
        throw new Error(`Assignment for ${owner} is no longer active`);
      }
      const resolved = await resolveTaskCwd(task, this.root);
      if (resolved.error) throw new Error(resolved.error);
      const cwd = await realpath(resolved.cwd);
      if (cwd !== lease.cwd) throw new Error(`Assignment cwd changed for task ${task.id}`);
      return cwd;
    });
  }

  // Drop the cwd lease only after the model turn that completed the task.
  async releaseCompleted(owner: string): Promise<boolean> {
    return withTaskLock(async () => {
      const lease = this.#leases.get(owner);
      if (!lease) return false;
      const task = await this.tasks.load(lease.taskId);
      if (task.status !== "completed" || task.owner !== owner) return false;
      this.#leases.delete(owner);
      this.#advance(owner);
      this.#gates.set(owner, "not_required");
      return true;
    });
  }

  async releaseTeammate(owner: string): Promise<void> {
    await withTaskLock(async () => {
      try {
        const task = await this.tasks.ownerInProgress(owner);
        if (task) await this.tasks.abandon(task.id, owner);
      } finally {
        this.#leases.delete(owner);
        this.#advance(owner);
        this.#gates.set(owner, "not_required");
      }
    });
  }

  #advance(owner: string): void {
    this.#versions.set(owner, (this.#versions.get(owner) ?? 0) + 1);
    const gate = this.#gates.get(owner);
    if (gate !== undefined && gate !== "not_required") this.#gates.set(owner, "required");
    this.#planRequestIds.delete(owner);
  }
}

export const assignments = new Assignments(taskStore, project);
