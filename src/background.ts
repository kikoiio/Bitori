import { spawn, type ChildProcess } from "node:child_process";
import { project } from "./config.ts";

const timeoutMs = 120_000;
const maxOutputBytes = 50_000;

type BackgroundStatus = "running" | "completed" | "failed";

type BackgroundTask = {
  command: string;
  status: BackgroundStatus;
};

type ReadyTask = {
  id: string;
  command: string;
  status: "completed" | "failed";
  result: string;
};

type TrackedChild = {
  child: ChildProcess;
  detached: boolean;
};

const tasks = new Map<string, BackgroundTask>();
const ready: ReadyTask[] = [];
const tracked = new Set<TrackedChild>();
const idleWaiters = new Set<() => void>();
let counter = 0;

export function hasRunningBackground(): boolean {
  for (const task of tasks.values()) {
    if (task.status === "running") return true;
  }
  return false;
}

export function hasBackgroundResult(): boolean {
  return ready.length > 0;
}

export function waitForBackgroundIdle(signal: AbortSignal): Promise<void> {
  if (!hasRunningBackground()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finishWait = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      idleWaiters.delete(finishWait);
      resolve();
    };
    const onAbort = () => finishWait();
    idleWaiters.add(finishWait);
    signal.addEventListener("abort", onAbort, { once: true });
    if (!hasRunningBackground() || signal.aborted) finishWait();
  });
}

function isExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalTarget(pid: number, detached: boolean): number {
  return detached && process.platform !== "win32" ? -pid : pid;
}

function stopSync(entry: TrackedChild): void {
  const { child, detached } = entry;
  if (isExited(child)) return;
  const pid = child.pid;
  if (pid === undefined) return;
  const target = signalTarget(pid, detached);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(target, signal);
    } catch {
      return;
    }
  }
}

function stopAllSync(): void {
  for (const entry of tracked) stopSync(entry);
}

function waitClose(child: ChildProcess, ms: number): Promise<boolean> {
  if (isExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve(false);
    }, ms);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", onClose);
  });
}

// Detached children sit in their own process group, so a signal reaches the shell and its children.
async function stopChild(child: ChildProcess, detached: boolean): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const target = signalTarget(pid, detached);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (isExited(child)) return;
    try {
      process.kill(target, signal);
    } catch {
      return;
    }
    if (await waitClose(child, 50)) return;
  }
}

function track(child: ChildProcess, detached: boolean): void {
  const entry = { child, detached };
  tracked.add(entry);
  child.once("close", () => tracked.delete(entry));
}

function renderResult(
  exitCode: number | null,
  stdout: Buffer,
  stderr: Buffer,
  truncated: boolean,
  failure: string | undefined,
): string {
  return JSON.stringify({
    exit_code: exitCode,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    truncated,
    error: failure,
  });
}

function take(chunks: Buffer[], received: number, chunk: Buffer): { received: number; overflow: boolean } {
  if (received >= maxOutputBytes) return { received, overflow: true };
  const room = maxOutputBytes - received;
  if (chunk.length > room) {
    chunks.push(chunk.subarray(0, room));
    return { received: maxOutputBytes, overflow: true };
  }
  chunks.push(chunk);
  return { received: received + chunk.length, overflow: false };
}

function notification(item: ReadyTask): string {
  return [
    "<task_notification>",
    `  <task_id>${item.id}</task_id>`,
    `  <status>${item.status}</status>`,
    `  <command>${item.command}</command>`,
    `  <summary>${item.result.slice(0, 500)}</summary>`,
    "</task_notification>",
  ].join("\n");
}

function finish(id: string, exitCode: number | null, result: string): void {
  const task = tasks.get(id);
  if (!task || task.status !== "running") return;
  const status = exitCode === 0 ? "completed" : "failed";
  task.status = status;
  ready.push({ id, command: task.command, status, result });
  if (!hasRunningBackground()) {
    for (const waiter of idleWaiters) waiter();
    idleWaiters.clear();
  }
}

function launch(id: string, command: string, timeout: number, cwd: string): void {
  const detached = process.platform !== "win32";
  const child = spawn(command, {
    shell: true,
    cwd,
    env: process.env,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  track(child, detached);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutReceived = 0;
  let stderrReceived = 0;
  let overflow = false;
  let timedOut = false;
  let settled = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = (
    exitCode: number | null,
    stdout: Buffer,
    stderr: Buffer,
    truncated: boolean,
    failure: string | undefined,
  ) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish(id, exitCode, renderResult(exitCode, stdout, stderr, truncated, failure));
  };

  const stopForLimit = () => {
    if (stopping || settled) return;
    stopping = true;
    void stopChild(child, detached);
  };

  const onChunk = (kind: "stdout" | "stderr", chunk: Buffer) => {
    if (kind === "stdout") {
      const next = take(stdoutChunks, stdoutReceived, chunk);
      stdoutReceived = next.received;
      overflow ||= next.overflow;
    } else {
      const next = take(stderrChunks, stderrReceived, chunk);
      stderrReceived = next.received;
      overflow ||= next.overflow;
    }
    if (stdoutReceived + stderrReceived >= maxOutputBytes) stopForLimit();
  };

  child.stdout?.on("data", (chunk: Buffer) => onChunk("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => onChunk("stderr", chunk));

  timer = setTimeout(() => {
    timedOut = true;
    void stopChild(child, detached).finally(() => {
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).subarray(0, maxOutputBytes);
      const stderr = Buffer.concat(stderrChunks).subarray(0, maxOutputBytes);
      settle(null, stdout, stderr, overflow, `Command timed out after ${timeout / 1000} seconds.`);
    });
  }, timeout);

  child.once("error", (error) => {
    settle(null, Buffer.alloc(0), Buffer.alloc(0), false, `Could not run the command (${error.message}).`);
  });

  child.once("close", (code, signal) => {
    const stdout = Buffer.concat(stdoutChunks);
    const stderr = Buffer.concat(stderrChunks);
    const stdoutBytes = stdout.subarray(0, maxOutputBytes);
    const stderrBytes = stderr.subarray(0, Math.max(0, maxOutputBytes - stdoutBytes.length));
    const truncated = overflow || stdout.length + stderr.length > maxOutputBytes;
    const exitCode = timedOut ? null : code;
    let failure: string | undefined;
    if (timedOut) failure = `Command timed out after ${timeout / 1000} seconds.`;
    else if (truncated) failure = `Output exceeded ${maxOutputBytes} bytes.`;
    else if (exitCode === null) failure = `Could not run the command (${signal ?? "unknown error"}).`;
    settle(exitCode, stdoutBytes, stderrBytes, truncated, failure);
  });
}

process.on("exit", stopAllSync);
process.on("SIGTERM", () => {
  stopAllSync();
  process.exit(128 + 15);
});

export function startBackgroundBash(command: string, timeout = timeoutMs, cwd = project): string {
  if (!command.trim()) throw new Error("Bash command cannot be empty");
  counter += 1;
  const id = `bg_${String(counter).padStart(4, "0")}`;
  tasks.set(id, { command, status: "running" });
  try {
    launch(id, command, timeout, cwd);
  } catch (error) {
    tasks.delete(id);
    throw error;
  }
  process.stderr.write(`  [background] started ${id}: ${command.slice(0, 60)}\n`);
  return id;
}

export function collectBackgroundNotifications(): string[] {
  const batch = ready.splice(0, ready.length);
  const notes: string[] = [];
  for (const item of batch) {
    tasks.delete(item.id);
    notes.push(notification(item));
    process.stderr.write(`  [background] collected ${item.id}: ${item.status}\n`);
  }
  return notes;
}
