import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type OpenAI from "openai";
import { project } from "./config.ts";

const defaultAgentCap = 1000;
const defaultConcurrency = 8;
const defaultStore = resolve(project, ".runtime");
const workflowNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const runIdPattern = /^wf_[A-Za-z0-9][A-Za-z0-9._-]{0,63}_[0-9a-f]{16}$/;
const journalMiss = Symbol("journal-miss");

export type RunId = string & { readonly __brand: "WorkflowRunId" };

export class WorkflowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInputError";
  }
}

export interface JsonSchema {
  type?: "object" | "array" | "string" | "boolean" | "number" | "integer";
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Readonly<Record<string, JsonSchema>>;
  items?: JsonSchema;
}

export interface RunnerOutput {
  value: unknown;
  tokens: number;
}

export interface AgentRunner {
  run(prompt: string, schema: JsonSchema | null, label: string): RunnerOutput | Promise<RunnerOutput>;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: readonly string[];
}

export interface WorkflowContext {
  phase(title: string): void;
  log(message: string): void;
  agent(prompt: string, options?: AgentOptions): Promise<unknown>;
  parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]>;
  pipeline(items: readonly unknown[], ...stages: WorkflowStage[]): Promise<unknown[]>;
  workflow(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface AgentOptions {
  schema?: JsonSchema | null;
  label?: string | null;
  phase?: string | null;
}

type WorkflowStage = (value: unknown, item: unknown, index: number) => Promise<unknown>;

export interface SavedWorkflow {
  meta: WorkflowMeta;
  run: (ctx: WorkflowContext, args: Record<string, unknown>) => Promise<unknown>;
}

export interface WorkflowCall {
  name: string;
  args?: Record<string, unknown> | null;
  resumeFromRunId?: string | null;
  store?: string;
  runner?: AgentRunner;
  deny?: readonly string[];
  agentCap?: number;
  concurrency?: number;
  workflows?: readonly SavedWorkflow[];
}

interface WorkflowTaskState {
  taskId: string;
  taskType: "local_workflow";
  runId: RunId;
  workflowName: string;
  status: "running" | "completed" | "failed";
  usage: { agents: number; tokens: number };
  progress: Array<Record<string, unknown>>;
}

export interface WorkflowResult {
  launched: {
    status: "async_launched";
    taskId: string;
    taskType: "local_workflow";
    runId: RunId;
    workflowName: string;
  };
  result: unknown;
  task: WorkflowTaskState;
}

const findingsSchema: JsonSchema = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "severity"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

const verdictSchema: JsonSchema = {
  type: "object",
  required: ["isReal", "reason"],
  properties: {
    isReal: { type: "boolean" },
    reason: { type: "string" },
  },
};

const reviewDimensions = ["correctness", "security", "performance", "style"];

const reviewWorkflow: SavedWorkflow = {
  meta: {
    name: "review-changes",
    description: "Review changed files across dimensions, verify each finding",
    phases: ["Review", "Verify"],
  },
  run: runReviewChanges,
};

export const savedWorkflows: readonly SavedWorkflow[] = [reviewWorkflow];

const workflowAgentEnvironment = process.platform === "win32"
  ? "Host OS: Windows. This workflow agent only responds to its supplied step; it has no direct shell or file tools."
  : "Host OS: Unix-like. This workflow agent only responds to its supplied step; it has no direct shell or file tools.";

const activeRuns = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function validateRunId(value: string): RunId {
  if (!runIdPattern.test(value)) throw new WorkflowInputError("invalid workflow runId");
  return value as RunId;
}

function validateMeta(meta: WorkflowMeta): void {
  if (!meta.name || !meta.description) throw new WorkflowInputError("meta requires `name` and `description`");
  if (!workflowNamePattern.test(meta.name)) {
    throw new WorkflowInputError("meta.name must be a 1-64 character slug using letters, numbers, '.', '_', or '-'");
  }
  if (typeof meta.description !== "string") throw new WorkflowInputError("meta.description must be a string");
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases) || meta.phases.some((phase) => typeof phase !== "string" || phase === "")) {
      throw new WorkflowInputError("meta.phases must be a list of non-empty strings");
    }
  }
}

function checkPermission(meta: WorkflowMeta, deny: ReadonlySet<string>): void {
  if (deny.has(meta.name)) throw new WorkflowInputError(`workflow '${meta.name}' denied by settings`);
}

export function validateJsonSchema(schema: JsonSchema, value: unknown): string | null {
  if (schema.enum !== undefined && !schema.enum.some((item) => Object.is(item, value))) {
    return `expected one of ${JSON.stringify(schema.enum)}`;
  }
  if (schema.type === "object") {
    if (!isRecord(value)) return "expected object";
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return `missing required key '${key}'`;
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateJsonSchema(child, value[key]);
      if (error) return `${key}: ${error}`;
    }
    return null;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return "expected array";
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateJsonSchema(schema.items, value[index]);
        if (error) return `[${index}]: ${error}`;
      }
    }
    return null;
  }
  if (schema.type === "string") return typeof value === "string" ? null : "expected string";
  if (schema.type === "boolean") return typeof value === "boolean" ? null : "expected boolean";
  if (schema.type === "number" || schema.type === "integer") {
    return typeof value === "number" && Number.isFinite(value) ? null : "expected number";
  }
  return null;
}

function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(Number.isFinite(value) ? value : null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(", ")}]`;
  if (isRecord(value)) {
    const body = Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}: ${canonicalJson(value[key])}`)
      .join(", ");
    return `{${body}}`;
  }
  return JSON.stringify(String(value));
}

function stableHash(value: string): bigint {
  return BigInt(`0x${createHash("sha256").update(value).digest("hex")}`);
}

function journalKey(kind: string, label: string, prompt: string, schema: JsonSchema | null): string {
  const basis = `${kind}|${label}|${prompt}|${canonicalJson(schema)}`;
  return `${kind}-${(stableHash(basis) % 10_000_000_000n).toString().padStart(10, "0")}`;
}

function fillSchema(schema: JsonSchema, seed: string): unknown {
  if (schema.type === "object") {
    const properties = schema.properties ?? {};
    const keys = schema.required ?? Object.keys(properties);
    const filled: Record<string, unknown> = {};
    for (const key of keys) {
      const child = properties[key];
      if (!child) throw new WorkflowInputError(`missing schema for '${key}'`);
      filled[key] = fillSchema(child, `${seed}/${key}`);
    }
    return filled;
  }
  if (schema.type === "array") {
    if (!schema.items) throw new WorkflowInputError("array schema requires items");
    return [fillSchema(schema.items, `${seed}/0`)];
  }
  if (schema.type === "boolean") return stableHash(seed) % 4n !== 0n;
  if (schema.type === "number" || schema.type === "integer") return Number(stableHash(seed) % 5n);
  const leaf = seed.split("/").pop();
  return leaf ?? seed;
}

function tokenCount(prompt: string, result: unknown): number {
  return Math.floor(prompt.length / 4) + Math.floor(JSON.stringify(result).length / 4);
}

export class MockAgentRunner implements AgentRunner {
  run(prompt: string, schema: JsonSchema | null, label: string): RunnerOutput {
    if (!schema) {
      const value = `[mock] ${(label || prompt).slice(0, 60)}`;
      return { value, tokens: tokenCount(prompt, value) };
    }
    const properties = schema.properties ?? {};
    let value: unknown;
    if (properties.findings) {
      const count = 1 + Number(stableHash(prompt) % 2n);
      const severities = ["high", "medium", "low"];
      const findings = [];
      for (let index = 0; index < count; index += 1) {
        findings.push({
          title: `${label || "audit"} #${index + 1}`,
          severity: severities[Number(stableHash(prompt + String(index)) % 3n)],
        });
      }
      value = { findings };
    } else if (Object.hasOwn(properties, "isReal")) {
      const real = stableHash(prompt) % 4n !== 0n;
      value = { isReal: real, reason: real ? "reproduced" : "could not reproduce" };
    } else {
      value = fillSchema(schema, prompt);
    }
    return { value, tokens: tokenCount(prompt, value) };
  }
}

function parseRunnerJson(text: string): unknown {
  let stripped = text.trim();
  if (stripped.startsWith("```")) {
    const lines = stripped.split(/\r?\n/).slice(1);
    if (lines.length > 0 && lines[lines.length - 1]?.trim() === "```") lines.pop();
    stripped = lines.join("\n").trim();
  }
  try {
    return JSON.parse(stripped);
  } catch {
    // The model may surround one object with commentary.
  }
  for (let start = 0; start < stripped.length; start += 1) {
    if (stripped[start] !== "{") continue;
    const end = endOfObject(stripped, start);
    if (end === null) continue;
    try {
      return JSON.parse(stripped.slice(start, end));
    } catch {
      continue;
    }
  }
  throw new WorkflowInputError("workflow agent returned invalid JSON");
}

function endOfObject(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function liveRunner(): AgentRunner {
  return {
    async run(prompt, schema) {
      let request = prompt;
      if (schema) {
        request += `\n\nReturn only one JSON object matching this schema:\n${canonicalJson(schema)}`;
      }
      const { requestWorkflowStep } = await import("./llm.ts");
      const response = await requestWorkflowStep(
        "You are a focused workflow agent. Complete only the supplied step. "
          + `${workflowAgentEnvironment} `
          + "Do not claim access to files or results not included in the prompt.",
        request,
      );
      if (!schema) return { value: response.text, tokens: response.tokens };
      try {
        return { value: parseRunnerJson(response.text), tokens: response.tokens };
      } catch (error) {
        if (error instanceof WorkflowInputError) return { value: response.text, tokens: response.tokens };
        throw error;
      }
    },
  };
}

class Semaphore {
  #available: number;
  #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#available = limit;
  }

  async acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return;
    }
    await new Promise<void>((resolveWait) => {
      this.#waiters.push(resolveWait);
    });
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#available += 1;
  }
}

class Budget {
  readonly total: number | null;
  #spent = 0;

  constructor(total: number | null) {
    this.total = total;
  }

  add(count: number): void {
    if (this.total !== null && this.#spent + count > this.total) {
      throw new WorkflowInputError(`token budget exceeded (${this.#spent + count} > ${this.total})`);
    }
    this.#spent += count;
  }

  remaining(): number {
    return this.total === null ? Number.POSITIVE_INFINITY : Math.max(0, this.total - this.#spent);
  }
}

class WorkflowJournal {
  readonly #path: string;
  readonly #cache = new Map<string, unknown>();

  constructor(path: string, resume: boolean, runId: RunId) {
    this.#path = path;
    if (resume) {
      if (!existsSync(path)) throw new WorkflowInputError(`resume journal not found for ${runId}`);
      const text = readFileSync(path, "utf8");
      for (const [index, line] of journalLines(text).entries()) {
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch (error) {
          throw new WorkflowInputError(`invalid resume journal record at line ${index + 1}`);
        }
        if (!isRecord(record) || typeof record.key !== "string" || !Object.hasOwn(record, "value")) {
          throw new WorkflowInputError(`invalid resume journal record at line ${index + 1}`);
        }
        this.#cache.set(record.key, record.value);
      }
      return;
    }
    writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
  }

  cached(key: string): unknown | typeof journalMiss {
    return this.#cache.has(key) ? this.#cache.get(key) : journalMiss;
  }

  record(key: string, value: unknown): void {
    appendFileSync(this.#path, `${JSON.stringify({ key, value })}\n`, "utf8");
    this.#cache.set(key, value);
  }
}

function journalLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

class ExecutionLimits {
  agents = 0;
  readonly semaphore: Semaphore;
  readonly #cap: number;

  constructor(cap: number, concurrency: number) {
    this.#cap = cap;
    this.semaphore = new Semaphore(concurrency);
  }

  claimAgent(): void {
    this.agents += 1;
    if (this.agents > this.#cap) throw new WorkflowInputError(`agent() cap reached (${this.#cap})`);
  }
}

class WorkflowTask {
  readonly taskId: string;
  readonly runId: RunId;
  readonly meta: WorkflowMeta;
  status: "running" | "completed" | "failed" = "running";
  readonly usage = { agents: 0, tokens: 0 };
  readonly progress: Array<Record<string, unknown>> = [];

  constructor(runId: RunId, meta: WorkflowMeta) {
    this.runId = runId;
    this.taskId = `local_workflow_${runId}`;
    this.meta = meta;
  }

  event(name: string, data: Record<string, unknown>): void {
    writeRuntimeLine("event", name.padEnd(18), data);
  }

  progressEvent(type: string, data: Record<string, unknown>): void {
    this.progress.push({ type, ...data });
    writeRuntimeLine("progress", type.padEnd(16), data);
  }

  snapshot(): WorkflowTaskState {
    return {
      taskId: this.taskId,
      taskType: "local_workflow",
      runId: this.runId,
      workflowName: this.meta.name,
      status: this.status,
      usage: { ...this.usage },
      progress: this.progress.map((event) => ({ ...event })),
    };
  }
}

function writeRuntimeLine(kind: "event" | "progress", label: string, data: Record<string, unknown>): void {
  const prefix = kind === "event" ? "  event      " : "  progress   ";
  const body = Object.entries(data)
    .map(([key, value]) => `${key}=${value === null ? "null" : String(value)}`)
    .join(" ");
  process.stderr.write(`${prefix}${label} ${body}\n`);
}

class ExecutionState implements WorkflowContext {
  #phase: string | null = null;
  readonly #phasesSeen = new Set<string>();
  readonly #task: WorkflowTask;
  readonly #journal: WorkflowJournal;
  readonly #runner: AgentRunner;
  readonly #budget: Budget;
  readonly #depth: number;
  readonly #limits: ExecutionLimits;
  readonly #workflows: ReadonlyMap<string, SavedWorkflow>;

  constructor(
    task: WorkflowTask,
    journal: WorkflowJournal,
    runner: AgentRunner,
    budget: Budget,
    depth: number,
    limits: ExecutionLimits,
    workflows: ReadonlyMap<string, SavedWorkflow>,
  ) {
    this.#task = task;
    this.#journal = journal;
    this.#runner = runner;
    this.#budget = budget;
    this.#depth = depth;
    this.#limits = limits;
    this.#workflows = workflows;
  }

  phase(title: string): void {
    this.#phase = title;
    if (this.#phasesSeen.has(title)) return;
    this.#phasesSeen.add(title);
    this.#task.progressEvent("workflow_phase", { title });
  }

  log(message: string): void {
    this.#task.progressEvent("workflow_log", { message });
  }

  async agent(prompt: string, options: AgentOptions = {}): Promise<unknown> {
    const schema = options.schema ?? null;
    const label = options.label || `${prompt.slice(0, 24)}...`;
    const phase = options.phase || this.#phase;
    // A cached call still takes an agent slot and stops when the budget is already spent.
    this.#limits.claimAgent();
    if (this.#budget.remaining() <= 0) throw new WorkflowInputError("token budget exceeded");
    const key = journalKey("agent", label, prompt, schema);
    const cached = this.#journal.cached(key);
    if (cached !== journalMiss) {
      if (schema) {
        const error = validateJsonSchema(schema, cached);
        if (error) throw new WorkflowInputError(`cached agent output failed schema validation: ${error}`);
      }
      this.#task.progressEvent("workflow_agent", { label, phase, status: "cached" });
      return cached;
    }

    await this.#limits.semaphore.acquire();
    let result: unknown;
    let tokens: number;
    try {
      const first = await this.#runner.run(prompt, schema, label);
      result = first.value;
      tokens = finiteTokens(first.tokens);
    } finally {
      this.#limits.semaphore.release();
    }
    if (schema) {
      let error = validateJsonSchema(schema, result);
      if (error) {
        const retry = await this.#runner.run(`${prompt}\n\nReturn valid JSON.`, schema, label);
        result = retry.value;
        tokens += finiteTokens(retry.tokens);
        error = validateJsonSchema(schema, result);
        if (error) throw new WorkflowInputError(`agent({schema}) invalid output: ${error}`);
      }
    }
    this.#budget.add(tokens);
    this.#task.usage.agents += 1;
    this.#task.usage.tokens += tokens;
    this.#journal.record(key, result);
    this.#task.progressEvent("workflow_agent", { label, phase, status: "done" });
    return result;
  }

  async parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]> {
    const settled = await Promise.allSettled(thunks.map((thunk) => thunk()));
    const values: unknown[] = [];
    for (const entry of settled) {
      if (entry.status === "rejected") throw entry.reason;
      values.push(entry.value);
    }
    return values;
  }

  async pipeline(items: readonly unknown[], ...stages: WorkflowStage[]): Promise<unknown[]> {
    return this.parallel(items.map((item, index) => async () => {
      let value: unknown = item;
      for (const stage of stages) value = await stage(value, item, index);
      return value;
    }));
  }

  async workflow(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#depth >= 1) throw new WorkflowInputError("workflow() nesting is one level only");
    const saved = this.#workflows.get(name);
    if (!saved) throw new WorkflowInputError(`unknown workflow '${name}'`);
    const child = new ExecutionState(
      this.#task,
      this.#journal,
      this.#runner,
      this.#budget,
      this.#depth + 1,
      this.#limits,
      this.#workflows,
    );
    return saved.run(child, args);
  }
}

function finiteTokens(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new WorkflowInputError("workflow agent returned an invalid token count");
  return value;
}

function runFile(store: string, runId: RunId, suffix: string): string {
  const path = resolve(store, `${runId}${suffix}`);
  const rel = relative(store, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new WorkflowInputError("invalid workflow runId");
  return path;
}

function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function reserveRunId(store: string, name: string): RunId {
  mkdirSync(store, { recursive: true });
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const runId = validateRunId(`wf_${name}_${randomBytes(8).toString("hex")}`);
    try {
      const fd = openSync(runFile(store, runId, ".json"), "wx", 0o600);
      closeSync(fd);
      return runId;
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue;
      throw error;
    }
  }
  throw new WorkflowInputError("could not allocate a unique workflow runId");
}

function acquireRun(store: string, runId: RunId): () => void {
  if (activeRuns.has(runId)) throw new WorkflowInputError(`workflow run ${runId} is already active`);
  activeRuns.add(runId);
  const lockPath = runFile(store, runId, ".lock");
  mkdirSync(store, { recursive: true });
  try {
    let owned = false;
    for (let attempt = 0; attempt < 3 && !owned; attempt += 1) {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        owned = true;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        const holder = readLockPid(lockPath);
        if (holder !== null && holder !== process.pid && pidAlive(holder)) {
          throw new WorkflowInputError(`workflow run ${runId} is already active`);
        }
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if (!isErrno(unlinkError, "ENOENT")) throw unlinkError;
        }
      }
    }
    if (!owned) throw new WorkflowInputError(`workflow run ${runId} is already active`);
  } catch (error) {
    activeRuns.delete(runId);
    throw error;
  }
  return () => {
    activeRuns.delete(runId);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  };
}

function readLockPid(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!/^[0-9]+$/.test(text)) return null;
    const pid = Number(text);
    return Number.isSafeInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function readSnapshot(store: string, runId: RunId): { workflowName: string; args: Record<string, unknown> } {
  const path = runFile(store, runId, ".json");
  if (!existsSync(path)) throw new WorkflowInputError(`resume snapshot not found for ${runId}`);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new WorkflowInputError(`invalid resume snapshot for ${runId}`);
  }
  if (!isRecord(snapshot) || typeof snapshot.workflowName !== "string" || !isRecord(snapshot.args)) {
    throw new WorkflowInputError(`invalid resume snapshot for ${runId}`);
  }
  return { workflowName: snapshot.workflowName, args: snapshot.args };
}

function budgetOf(args: Record<string, unknown>): number | null {
  if (!Object.hasOwn(args, "budget") || args.budget === null) return null;
  if (typeof args.budget !== "number" || !Number.isFinite(args.budget)) {
    throw new WorkflowInputError("args.budget must be a number");
  }
  return args.budget;
}

function registryOf(workflows: readonly SavedWorkflow[]): Map<string, SavedWorkflow> {
  const registry = new Map<string, SavedWorkflow>();
  for (const workflow of workflows) {
    validateMeta(workflow.meta);
    if (registry.has(workflow.meta.name)) throw new WorkflowInputError(`duplicate workflow '${workflow.meta.name}'`);
    registry.set(workflow.meta.name, workflow);
  }
  return registry;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new WorkflowInputError(`${label} must be a positive integer`);
  return value;
}

export async function runWorkflow(call: WorkflowCall): Promise<WorkflowResult> {
  if (typeof call.name !== "string") throw new WorkflowInputError("workflow name must be a string");
  if (call.args !== undefined && call.args !== null && !isRecord(call.args)) {
    throw new WorkflowInputError("workflow args must be an object");
  }
  const workflows = registryOf(call.workflows ?? savedWorkflows);
  const saved = workflows.get(call.name);
  if (!saved) throw new WorkflowInputError(`unknown workflow '${call.name}'`);
  validateMeta(saved.meta);
  checkPermission(saved.meta, new Set(call.deny ?? []));
  const store = resolve(call.store ?? defaultStore);
  const agentCap = requirePositiveInteger(call.agentCap ?? defaultAgentCap, "agent cap");
  const concurrency = requirePositiveInteger(call.concurrency ?? defaultConcurrency, "concurrency");
  const resuming = call.resumeFromRunId !== undefined && call.resumeFromRunId !== null;
  const runId = resuming ? validateRunId(call.resumeFromRunId ?? "") : reserveRunId(store, saved.meta.name);
  const release = acquireRun(store, runId);
  try {
    return await runLocked(saved, workflows, call.args ?? null, store, runId, resuming, call.runner ?? liveRunner(), agentCap, concurrency);
  } finally {
    release();
  }
}

async function runLocked(
  saved: SavedWorkflow,
  workflows: ReadonlyMap<string, SavedWorkflow>,
  suppliedArgs: Record<string, unknown> | null,
  store: string,
  runId: RunId,
  resuming: boolean,
  runner: AgentRunner,
  agentCap: number,
  concurrency: number,
): Promise<WorkflowResult> {
  let args: Record<string, unknown>;
  if (resuming) {
    const snapshot = readSnapshot(store, runId);
    if (snapshot.workflowName !== saved.meta.name) {
      throw new WorkflowInputError("resume runId does not match workflow meta");
    }
    if (suppliedArgs === null) args = snapshot.args;
    else if (canonicalJson(suppliedArgs) !== canonicalJson(snapshot.args)) {
      throw new WorkflowInputError("resume args do not match the original run");
    } else args = suppliedArgs;
  } else {
    args = suppliedArgs ?? {};
  }
  budgetOf(args);
  const journal = new WorkflowJournal(runFile(store, runId, ".journal.jsonl"), resuming, runId);
  const task = new WorkflowTask(runId, saved.meta);
  const launched = {
    status: "async_launched" as const,
    taskId: task.taskId,
    taskType: "local_workflow" as const,
    runId,
    workflowName: saved.meta.name,
  };
  task.event("async_launched", { runId, taskId: task.taskId });
  task.event("task_started", {
    workflow: saved.meta.name,
    phases: saved.meta.phases?.join(",") || "-",
    resume: resuming,
  });
  const envelope = () => ({ runId, workflowName: saved.meta.name, args, task: task.snapshot() });
  writeJson(runFile(store, runId, ".json"), envelope());
  let result: unknown;
  try {
    const state = new ExecutionState(
      task,
      journal,
      runner,
      new Budget(budgetOf(args)),
      0,
      new ExecutionLimits(agentCap, concurrency),
      workflows,
    );
    const returned = await saved.run(state, args);
    result = returned === undefined ? null : returned;
    task.status = "completed";
  } catch (error) {
    task.status = "failed";
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  const outputPath = runFile(store, runId, ".output.json");
  writeJson(outputPath, result);
  writeJson(runFile(store, runId, ".json"), envelope());
  writeFileSync(resolve(store, "last_run.txt"), runId, { encoding: "utf8", mode: 0o600 });
  const outputFile = relative(project, outputPath);
  task.event("task_notification", {
    status: task.status,
    agents: task.usage.agents,
    tokens: task.usage.tokens,
    outputFile: outputFile.startsWith("..") || isAbsolute(outputFile) ? outputPath : outputFile,
  });
  return { launched, result, task: task.snapshot() };
}

interface Finding {
  title: string;
  severity: string;
}

function isFinding(value: unknown): value is Finding {
  return isRecord(value) && typeof value.title === "string" && typeof value.severity === "string";
}

async function runReviewChanges(ctx: WorkflowContext, args: Record<string, unknown>): Promise<unknown> {
  ctx.phase("Review");
  const changes = Object.hasOwn(args, "changes") ? args.changes : "";
  if (typeof changes !== "string") throw new WorkflowInputError("args.changes must be a string");
  const reviewInput = changes.trim() || "No change context was supplied.";
  const audit = async (_value: unknown, dimension: unknown): Promise<unknown> => {
    if (typeof dimension !== "string") throw new WorkflowInputError("review dimension must be a string");
    const out = await ctx.agent(
      `Review this change context for ${dimension} issues. `
        + "Report only issues supported by the supplied text.\n\n"
        + reviewInput,
      { schema: findingsSchema, label: `audit:${dimension}`, phase: "Review" },
    );
    if (!isRecord(out) || !Array.isArray(out.findings) || !out.findings.every(isFinding)) {
      throw new WorkflowInputError("agent({schema}) invalid output: expected findings");
    }
    return { dimension, findings: out.findings };
  };
  const verify = async (audited: unknown, dimension: unknown): Promise<unknown> => {
    ctx.phase("Verify");
    if (typeof dimension !== "string" || !isRecord(audited) || !Array.isArray(audited.findings)) {
      throw new WorkflowInputError("agent({schema}) invalid output: expected findings");
    }
    const findings = audited.findings.filter(isFinding);
    const verdicts = await ctx.parallel(findings.map((finding) => async () => ctx.agent(
      `Adversarially verify this ${dimension} finding against the supplied change context.\n\n`
        + `Change context:\n${reviewInput}\n\n`
        + `Finding:\n${JSON.stringify(finding)}`,
      { schema: verdictSchema, label: `verify:${dimension}:${finding.title}`, phase: "Verify" },
    )));
    const confirmed = findings.filter((finding, index) => {
      const verdict = verdicts[index];
      return isRecord(verdict) && verdict.isReal === true;
    });
    return { dimension, confirmed };
  };
  const results = await ctx.pipeline(reviewDimensions, audit, verify);
  const confirmed: Array<Finding & { dimension: string }> = [];
  for (const result of results) {
    if (!isRecord(result) || typeof result.dimension !== "string" || !Array.isArray(result.confirmed)) {
      throw new WorkflowInputError("agent({schema}) invalid output: expected findings");
    }
    for (const finding of result.confirmed) {
      if (!isFinding(finding)) throw new WorkflowInputError("agent({schema}) invalid output: expected findings");
      confirmed.push({ dimension: result.dimension, title: finding.title, severity: finding.severity });
    }
  }
  const rank = new Map<string, number>([["high", 0], ["medium", 1], ["low", 2]]);
  confirmed.sort((left, right) => (rank.get(left.severity) ?? 3) - (rank.get(right.severity) ?? 3));
  ctx.log(`confirmed ${confirmed.length} real finding(s)`);
  return { confirmed };
}

export const workflowTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "Workflow",
  description: "Run a saved workflow by name. Pass the change text in changes. "
    + "budget null means no token cap. "
    + "resume_from_run_id replays a finished run from its journal; pass an empty string to start a new run.\n"
    + savedWorkflows.map((workflow) => `${workflow.meta.name}: ${workflow.meta.description}`).join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", enum: savedWorkflows.map((workflow) => workflow.meta.name) },
      changes: { type: "string" },
      budget: { type: ["integer", "null"] },
      resume_from_run_id: { type: "string" },
    },
    required: ["name", "changes", "budget", "resume_from_run_id"],
    additionalProperties: false,
  },
  strict: true,
};
