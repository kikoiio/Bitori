import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { project } from "./config.ts";

// Five-field local cron. Sunday is 0. When both day-of-month and day-of-week
// are restricted, either field matching is enough; that is standard cron OR.

const cronIdPattern = /^cron_[0-9a-f]{8}$/;
const durableName = ".scheduled_tasks.json";

export type CronId = string & { readonly __brand: "CronId" };

export type CronJob = {
  id: CronId;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  pendingDelivery: boolean;
  lastFired: string | null;
};

export type ScheduleRequest = {
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
};

type CronField =
  | { kind: "any" }
  | { kind: "step"; step: number }
  | { kind: "range"; start: number; end: number }
  | { kind: "value"; value: number }
  | { kind: "list"; parts: CronField[] };

type ParsedCron = {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  weekday: CronField;
  dayText: string;
  weekdayText: string;
};

let scheduledTurn = false;

export function isScheduledTurn(): boolean {
  return scheduledTurn;
}

export function beginScheduledTurn(): void {
  scheduledTurn = true;
}

export function endScheduledTurn(): void {
  scheduledTurn = false;
}

function log(message: string): void {
  process.stderr.write(`  [cron] ${message}\n`);
}

export function noteDelivered(job: CronJob): void {
  log(`delivered ${job.id}: ${job.prompt.slice(0, 60)}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cronParts(expression: string): string[] {
  const trimmed = expression.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}

function parseField(field: string, minimum: number, maximum: number): CronField {
  if (field === "*") return { kind: "any" };
  if (field.startsWith("*/")) {
    const stepText = field.slice(2);
    if (!/^\d+$/.test(stepText) || Number(stepText) <= 0) {
      throw new Error(`Invalid step: ${field}`);
    }
    return { kind: "step", step: Number(stepText) };
  }
  if (field.includes(",")) {
    const parts = field.split(",").map((part) => parseField(part.trim(), minimum, maximum));
    return { kind: "list", parts };
  }
  if (field.includes("-")) {
    const splitAt = field.indexOf("-");
    const startText = field.slice(0, splitAt);
    const endText = field.slice(splitAt + 1);
    if (!/^\d+$/.test(startText) || !/^\d+$/.test(endText)) {
      throw new Error(`Invalid range: ${field}`);
    }
    const start = Number(startText);
    const end = Number(endText);
    if (start > end) throw new Error(`Range start is greater than end: ${field}`);
    if (start < minimum || end > maximum) {
      throw new Error(`Range ${field} is outside [${minimum}-${maximum}]`);
    }
    return { kind: "range", start, end };
  }
  if (!/^\d+$/.test(field)) throw new Error(`Invalid field: ${field}`);
  const value = Number(field);
  if (value < minimum || value > maximum) {
    throw new Error(`Value ${value} is outside [${minimum}-${maximum}]`);
  }
  return { kind: "value", value };
}

function parseNamed(name: string, field: string, minimum: number, maximum: number): CronField {
  try {
    return parseField(field, minimum, maximum);
  } catch (error) {
    throw new Error(`${name}: ${errorText(error)}`);
  }
}

function parseCron(expression: string): ParsedCron {
  const parts = cronParts(expression);
  if (parts.length !== 5) throw new Error(`Expected 5 fields, got ${parts.length}`);
  const minuteText = parts[0];
  const hourText = parts[1];
  const dayText = parts[2];
  const monthText = parts[3];
  const weekdayText = parts[4];
  if (
    minuteText === undefined
    || hourText === undefined
    || dayText === undefined
    || monthText === undefined
    || weekdayText === undefined
  ) {
    throw new Error(`Expected 5 fields, got ${parts.length}`);
  }
  return {
    minute: parseNamed("minute", minuteText, 0, 59),
    hour: parseNamed("hour", hourText, 0, 23),
    day: parseNamed("day-of-month", dayText, 1, 31),
    month: parseNamed("month", monthText, 1, 12),
    weekday: parseNamed("day-of-week", weekdayText, 0, 6),
    dayText,
    weekdayText,
  };
}

function fieldMatches(field: CronField, value: number): boolean {
  switch (field.kind) {
    case "any":
      return true;
    case "step":
      return value % field.step === 0;
    case "range":
      return field.start <= value && value <= field.end;
    case "value":
      return value === field.value;
    case "list":
      return field.parts.some((part) => fieldMatches(part, value));
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

export function validateCron(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

export function cronMatches(expression: string, moment: Date): boolean {
  let parsed: ParsedCron;
  try {
    parsed = parseCron(expression);
  } catch {
    return false;
  }
  if (!fieldMatches(parsed.minute, moment.getMinutes())) return false;
  if (!fieldMatches(parsed.hour, moment.getHours())) return false;
  if (!fieldMatches(parsed.month, moment.getMonth() + 1)) return false;
  const dayMatches = fieldMatches(parsed.day, moment.getDate());
  const weekdayMatches = fieldMatches(parsed.weekday, moment.getDay());
  if (parsed.dayText === "*" && parsed.weekdayText === "*") return true;
  if (parsed.dayText === "*") return weekdayMatches;
  if (parsed.weekdayText === "*") return dayMatches;
  return dayMatches || weekdayMatches;
}

function toCronId(value: unknown): CronId {
  if (typeof value !== "string" || !cronIdPattern.test(value)) {
    throw new Error("invalid job ID");
  }
  return value as CronId;
}

function requireString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function requireBoolean(data: Record<string, unknown>, key: string): boolean {
  const value = data[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function parseJob(data: unknown): CronJob {
  if (!isRecord(data)) throw new Error("expected an object");
  const id = toCronId(data.id);
  const cron = requireString(data, "cron");
  const cronError = validateCron(cron);
  if (cronError) throw new Error(cronError);
  const prompt = requireString(data, "prompt");
  if (!prompt.trim()) throw new Error("prompt cannot be empty");
  const lastFired = data.lastFired;
  if (lastFired !== null && typeof lastFired !== "string") {
    throw new Error("lastFired must be a string or null");
  }
  return {
    id,
    cron: cronParts(cron).join(" "),
    prompt,
    recurring: requireBoolean(data, "recurring"),
    durable: requireBoolean(data, "durable"),
    pendingDelivery: requireBoolean(data, "pendingDelivery"),
    lastFired,
  };
}

function formatMinute(moment: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} `
    + `${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
}

function serialize(job: CronJob): CronJob {
  return {
    id: job.id,
    cron: job.cron,
    prompt: job.prompt,
    recurring: job.recurring,
    durable: job.durable,
    pendingDelivery: job.pendingDelivery,
    lastFired: job.lastFired,
  };
}

export function formatScheduled(job: CronJob): string {
  return `Scheduled ${job.id}: ${job.cron} -> ${job.prompt}`;
}

export function formatCronList(jobs: readonly CronJob[]): string {
  if (jobs.length === 0) return "No cron jobs.";
  return jobs.map((job) => {
    const frequency = job.recurring ? "recurring" : "one-shot";
    const storage = job.durable ? "durable" : "session";
    return `${job.id}: ${job.cron} -> ${job.prompt.slice(0, 60)} [${frequency}, ${storage}]`;
  }).join("\n");
}

export class CronScheduler {
  readonly file: string;
  #jobs = new Map<CronId, CronJob>();
  #queue: CronJob[] = [];
  #waiters: Array<() => void> = [];
  #tail: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #loaded = false;

  constructor(file: string) {
    this.file = file;
  }

  // File writes yield. The chain keeps schedule, poll, and delivery off the same snapshot.
  #exclusive<T>(action: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(action, action);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  #notify(): void {
    const waiters = this.#waiters.splice(0);
    for (const wake of waiters) wake();
  }

  async #save(): Promise<void> {
    const payload = [...this.#jobs.values()].filter((job) => job.durable).map(serialize);
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  #newId(): CronId {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = toCronId(`cron_${randomBytes(4).toString("hex")}`);
      if (!this.#jobs.has(id)) return id;
    }
    throw new Error("Could not allocate a cron job ID");
  }

  async load(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#loaded) return;
      let text: string;
      try {
        text = await readFile(this.file, "utf8");
      } catch (error) {
        if (isEnoent(error)) {
          this.#loaded = true;
          return;
        }
        log(`could not load ${basename(this.file)}: ${errorText(error)}`);
        this.#loaded = true;
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
        if (!Array.isArray(payload)) throw new Error("expected a JSON list");
      } catch (error) {
        log(`could not load ${basename(this.file)}: ${errorText(error)}`);
        this.#loaded = true;
        return;
      }
      let loaded = 0;
      for (const item of payload) {
        try {
          const job = parseJob(item);
          if (this.#jobs.has(job.id)) throw new Error(`duplicate job ID ${job.id}`);
          this.#jobs.set(job.id, job);
          if (job.pendingDelivery) this.#queue.push(job);
          loaded += 1;
        } catch (error) {
          log(`skipped invalid saved job: ${errorText(error)}`);
        }
      }
      this.#loaded = true;
      if (loaded > 0) log(`loaded ${loaded} durable job(s)`);
      if (this.#queue.length > 0) this.#notify();
    });
  }

  start(): void {
    if (this.#timer) return;
    const timer = setInterval(() => {
      void this.poll(new Date()).catch((error: unknown) => {
        log(`poll failed: ${errorText(error)}`);
      });
    }, 1000);
    timer.unref();
    this.#timer = timer;
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  hasQueued(): boolean {
    return this.#queue.length > 0;
  }

  waitUntilQueued(signal: AbortSignal): Promise<void> {
    if (this.#queue.length > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let wake: () => void = () => undefined;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.#waiters = this.#waiters.filter((waiter) => waiter !== wake);
        if (ok) resolve();
        else reject(new Error("cron wait aborted"));
      };
      const onAbort = () => finish(false);
      wake = () => finish(true);
      this.#waiters.push(wake);
      signal.addEventListener("abort", onAbort, { once: true });
      if (this.#queue.length > 0) finish(true);
      else if (signal.aborted) finish(false);
    });
  }

  async schedule(request: ScheduleRequest): Promise<CronJob> {
    return this.#exclusive(async () => {
      const cronError = validateCron(request.cron);
      if (cronError) throw new Error(cronError);
      const prompt = request.prompt.trim();
      if (!prompt) throw new Error("Prompt cannot be empty");
      const job: CronJob = {
        id: this.#newId(),
        cron: cronParts(request.cron).join(" "),
        prompt,
        recurring: request.recurring,
        durable: request.durable,
        pendingDelivery: false,
        lastFired: null,
      };
      this.#jobs.set(job.id, job);
      try {
        if (job.durable) await this.#save();
      } catch (error) {
        this.#jobs.delete(job.id);
        throw error;
      }
      log(`scheduled ${job.id}: ${job.cron} -> ${job.prompt.slice(0, 60)}`);
      return job;
    });
  }

  async cancel(id: string): Promise<string> {
    return this.#exclusive(async () => {
      if (!cronIdPattern.test(id)) return `Job ${id} not found`;
      const cronId = toCronId(id);
      const job = this.#jobs.get(cronId);
      if (!job) return `Job ${id} not found`;
      const previousQueue = this.#queue.slice();
      this.#jobs.delete(cronId);
      this.#queue = this.#queue.filter((queued) => queued.id !== cronId);
      try {
        if (job.durable) await this.#save();
      } catch (error) {
        this.#jobs.set(cronId, job);
        this.#queue = previousQueue;
        throw error;
      }
      log(`cancelled ${cronId}`);
      return `Cancelled ${cronId}`;
    });
  }

  async list(): Promise<CronJob[]> {
    return this.#exclusive(async () => [...this.#jobs.values()]);
  }

  async poll(moment: Date): Promise<void> {
    return this.#exclusive(async () => {
      const marker = formatMinute(moment);
      for (const job of [...this.#jobs.values()]) {
        if (job.pendingDelivery || job.lastFired === marker) continue;
        if (!cronMatches(job.cron, moment)) continue;
        const previousPending = job.pendingDelivery;
        const previousFired = job.lastFired;
        job.pendingDelivery = true;
        job.lastFired = marker;
        try {
          if (job.durable) await this.#save();
        } catch (error) {
          job.pendingDelivery = previousPending;
          job.lastFired = previousFired;
          log(`could not enqueue ${job.id}: ${errorText(error)}`);
          continue;
        }
        this.#queue.push(job);
        log(`due ${job.id}: ${job.prompt.slice(0, 60)}`);
        this.#notify();
      }
    });
  }

  async consume(): Promise<CronJob[]> {
    return this.#exclusive(async () => this.#queue.splice(0));
  }

  // Pending stays set until the turn commits, so a failed turn still has the prompt.
  async acknowledge(jobs: readonly CronJob[]): Promise<void> {
    if (jobs.length === 0) return;
    return this.#exclusive(async () => {
      const changed: { job: CronJob; pendingDelivery: boolean }[] = [];
      const removed: CronJob[] = [];
      for (const delivered of jobs) {
        const current = this.#jobs.get(delivered.id);
        if (!current) continue;
        changed.push({ job: current, pendingDelivery: current.pendingDelivery });
        if (current.recurring) {
          current.pendingDelivery = false;
        } else {
          removed.push(current);
          this.#jobs.delete(current.id);
        }
      }
      try {
        if (changed.some(({ job }) => job.durable)) await this.#save();
      } catch (error) {
        for (const job of removed) this.#jobs.set(job.id, job);
        for (const entry of changed) entry.job.pendingDelivery = entry.pendingDelivery;
        const queued = new Set(this.#queue.map((job) => job.id));
        for (const entry of changed) {
          if (!queued.has(entry.job.id)) {
            this.#queue.push(entry.job);
            queued.add(entry.job.id);
          }
        }
        this.#notify();
        throw error;
      }
    });
  }

  async restore(jobs: readonly CronJob[]): Promise<void> {
    if (jobs.length === 0) return;
    return this.#exclusive(async () => {
      const queued = new Set(this.#queue.map((job) => job.id));
      let added = false;
      for (const delivered of jobs) {
        const current = this.#jobs.get(delivered.id);
        if (!current) continue;
        current.pendingDelivery = true;
        if (!queued.has(current.id)) {
          this.#queue.push(current);
          queued.add(current.id);
          added = true;
        }
      }
      if (added) this.#notify();
    });
  }
}

export const cronScheduler = new CronScheduler(resolve(project, durableName));
