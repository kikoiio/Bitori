import type OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { assignments as liveAssignments, type Assignments, type PlanGate } from "./assignments.ts";
import { mailbox as liveMailbox, type Mailbox, type MailMessage } from "./mailbox.ts";
import { isAgentName } from "./names.ts";
import { formatTaskList, type Task } from "./tasks.ts";
import { createWorktree as createTaskWorktree } from "./worktree.ts";

const idleScanMs = 2_000;
const maxToolRounds = 30;
const reservedNames = new Set(["lead", "agent"]);
const mutatingTools = new Set(["bash", "write_file", "edit_file"]);
const workspaceTools = new Set(["bash", "read_file", "write_file", "edit_file", "glob"]);

type TeammateStatus = "working" | "waiting_approval" | "idle" | "stopping";
type LoopState = "continue" | "idle" | "stop";
type ProtocolType = "shutdown" | "plan_approval";
type ProtocolStatus = "pending" | "approved" | "rejected";

type ProtocolState = {
  requestId: string;
  type: ProtocolType;
  sender: string;
  target: string;
  status: ProtocolStatus;
  payload: string;
  workVersion: number | null;
  taskId: string | null;
};

export type TeamAsk = (
  messages: OpenAI.Responses.ResponseInput,
  tools: OpenAI.Responses.FunctionTool[],
) => Promise<{ output: OpenAI.Responses.ResponseOutputItem[] }>;

type WorkspaceRunner = (name: string, args: unknown, cwd: string) => Promise<string>;

let workspaceRunner: WorkspaceRunner | undefined;

export function installWorkspaceRunner(runner: WorkspaceRunner): void {
  workspaceRunner = runner;
}

async function runWorkspace(name: string, args: unknown, cwd: string): Promise<string> {
  if (!workspaceRunner) throw new Error("Workspace runner is not installed.");
  return workspaceRunner(name, args, cwd);
}

const defaultAsk: TeamAsk = async (messages, tools) => {
  const { request } = await import("./llm.ts");
  const { output } = await request(messages, tools, (text) => {
    process.stderr.write(text);
  });
  return { output };
};

function requestIdOf(message: MailMessage): string {
  const value = message.metadata.request_id;
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, name: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${name} expects ${key} to be a string without NUL bytes.`);
  }
  return value;
}

function finalText(output: readonly OpenAI.Responses.ResponseOutputItem[]): string {
  return output
    .flatMap((item) => (item.type === "message" ? item.content : []))
    .map((part) => (part.type === "output_text" ? part.text : part.refusal))
    .join("")
    .trim();
}

function isFunctionCall(
  item: OpenAI.Responses.ResponseOutputItem,
): item is OpenAI.Responses.ResponseFunctionToolCall {
  return item.type === "function_call";
}

function formatTeamEvents(messages: readonly MailMessage[]): string {
  const lines = messages.map((message) => {
    const requestId = requestIdOf(message);
    const suffix = requestId ? ` request_id=${requestId}` : "";
    return `[${message.type}${suffix}] ${message.from}: ${message.content}`;
  });
  return `[Team events]\n${lines.join("\n")}`;
}

async function waitForInbox(box: Mailbox, agent: string, signal: AbortSignal): Promise<MailMessage[]> {
  const ready = await box.read(agent);
  if (ready.length > 0 || signal.aborted) return ready;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), idleScanMs);
  timer.unref();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await box.waitFor(agent, controller.signal);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) return [];
  return box.read(agent);
}

const teammateBashTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "bash",
  description: "Run a shell command in the task working directory.",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
    additionalProperties: false,
  },
  strict: true,
};

const teammateReadTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "read_file",
  description: "Read a UTF-8 text file in the task working directory. Pass limit to keep the first N lines.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: ["integer", "null"] },
    },
    required: ["path", "limit"],
    additionalProperties: false,
  },
  strict: true,
};

const teammateWriteTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "write_file",
  description: "Write a file in the task working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  strict: true,
};

const teammateEditTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "edit_file",
  description: "Replace one exact occurrence in a file in the task working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" },
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false,
  },
  strict: true,
};

const teammateGlobTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "glob",
  description: "Find files in the task working directory. ** matches recursively.",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" } },
    required: ["pattern"],
    additionalProperties: false,
  },
  strict: true,
};

const sendMessageTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "send_message",
  description: "Send an intermediate message to 'lead' or an active teammate.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string" },
      content: { type: "string" },
    },
    required: ["to", "content"],
    additionalProperties: false,
  },
  strict: true,
};

const submitPlanTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "submit_plan",
  description: "Submit a work plan and wait for Lead approval before workspace changes.",
  parameters: {
    type: "object",
    properties: { plan: { type: "string" } },
    required: ["plan"],
    additionalProperties: false,
  },
  strict: true,
};

const teammateListTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "list_tasks",
  description: "List shared tasks with status, owner, dependencies, and worktree.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  strict: true,
};

const teammateClaimTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "claim_task",
  description: "Claim a ready task. The assigned task in the first message is already claimed.",
  parameters: {
    type: "object",
    properties: { task_id: { type: "string" } },
    required: ["task_id"],
    additionalProperties: false,
  },
  strict: true,
};

const teammateCompleteTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "complete_task",
  description: "Complete the task this teammate owns.",
  parameters: {
    type: "object",
    properties: { task_id: { type: "string" } },
    required: ["task_id"],
    additionalProperties: false,
  },
  strict: true,
};

const teammateTools: OpenAI.Responses.FunctionTool[] = [
  teammateBashTool,
  teammateReadTool,
  teammateWriteTool,
  teammateEditTool,
  teammateGlobTool,
  sendMessageTool,
  submitPlanTool,
  teammateListTool,
  teammateClaimTool,
  teammateCompleteTool,
];

export const spawnTeammateTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "spawn_teammate",
  description: "Spawn a persistent teammate after the user has confirmed the team. "
    + "Pass task_id when assigning a ready task; an empty task_id spawns without one. "
    + "require_plan makes the teammate submit a plan before workspace changes. "
    + "After spawning, end the turn.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
      role: { type: "string" },
      prompt: { type: "string" },
      task_id: { type: "string" },
      require_plan: { type: "boolean" },
    },
    required: ["name", "role", "prompt", "task_id", "require_plan"],
    additionalProperties: false,
  },
  strict: true,
};

export const listTeammatesTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "list_teammates",
  description: "List active teammates and their status.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  strict: true,
};

export const leadSendTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "send_message",
  description: "Send a message to an active teammate.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string" },
      content: { type: "string" },
    },
    required: ["to", "content"],
    additionalProperties: false,
  },
  strict: true,
};

export const requestShutdownTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "request_shutdown",
  description: "Ask a teammate to finish the current step and shut down.",
  parameters: {
    type: "object",
    properties: { teammate: { type: "string" } },
    required: ["teammate"],
    additionalProperties: false,
  },
  strict: true,
};

export const requestPlanTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "request_plan",
  description: "Require a teammate to submit a plan before changing the workspace.",
  parameters: {
    type: "object",
    properties: {
      teammate: { type: "string" },
      task: { type: "string" },
    },
    required: ["teammate", "task"],
    additionalProperties: false,
  },
  strict: true,
};

export const reviewPlanTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "review_plan",
  description: "Approve or reject a teammate plan. feedback may be empty.",
  parameters: {
    type: "object",
    properties: {
      request_id: { type: "string" },
      approve: { type: "boolean" },
      feedback: { type: "string" },
    },
    required: ["request_id", "approve", "feedback"],
    additionalProperties: false,
  },
  strict: true,
};

export const createWorktreeTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "create_worktree",
  description: "Create a Git worktree and bind it to a pending, unowned task. "
    + "The worktree is that task's working directory, not a sandbox.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        pattern: "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        maxLength: 64,
      },
      task_id: { type: "string", pattern: "^task_[0-9a-f]{8}$" },
    },
    required: ["name", "task_id"],
    additionalProperties: false,
  },
  strict: true,
};

export const teamTools: OpenAI.Responses.FunctionTool[] = [
  spawnTeammateTool,
  listTeammatesTool,
  leadSendTool,
  requestShutdownTool,
  requestPlanTool,
  reviewPlanTool,
  createWorktreeTool,
];

export class TeamHost {
  readonly assignments: Assignments;
  readonly mailbox: Mailbox;
  readonly ask: TeamAsk;
  #status = new Map<string, TeammateStatus>();
  #loops = new Map<string, Promise<void>>();
  #requests = new Map<string, ProtocolState>();
  #abort = new AbortController();

  constructor(assignments: Assignments, mailbox: Mailbox, ask: TeamAsk) {
    this.assignments = assignments;
    this.mailbox = mailbox;
    this.ask = ask;
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  load(): Promise<void> {
    return this.mailbox.load();
  }

  hasActive(): boolean {
    return this.#status.size > 0;
  }

  hasLeadMail(): boolean {
    return this.mailbox.has("lead");
  }

  waitForLead(signal: AbortSignal): Promise<void> {
    return this.mailbox.waitFor("lead", signal);
  }

  list(): string {
    if (this.#status.size === 0) return "No active teammates.";
    return [...this.#status.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, status]) => `${name}: ${status}`)
      .join("\n");
  }

  statusOf(name: string): TeammateStatus | undefined {
    return this.#status.get(name);
  }

  markStatus(name: string, status: TeammateStatus): void {
    if (this.#status.has(name)) this.#status.set(name, status);
  }

  finish(name: string): void {
    this.#status.delete(name);
    this.#loops.delete(name);
    this.assignments.clearRuntime(name);
  }

  async spawn(
    name: string,
    role: string,
    prompt: string,
    taskId: string | null,
    requirePlan: boolean,
  ): Promise<string> {
    if (!isAgentName(name)) {
      return "Invalid teammate name: use 1-64 letters, digits, underscores, or dashes";
    }
    if (reservedNames.has(name.toLowerCase())) {
      return `Invalid teammate name: '${name}' is reserved by the runtime`;
    }
    if ([...this.#status.keys()].some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      return `Teammate '${name}' already exists`;
    }
    this.#status.set(name, "working");
    this.assignments.prepare(name, requirePlan);
    if (taskId) {
      let claimed: string;
      try {
        claimed = await this.assignments.claim(taskId, name);
      } catch (error) {
        claimed = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (!claimed.startsWith("Claimed ")) {
        this.#status.delete(name);
        this.assignments.forget(name);
        return `Cannot spawn teammate '${name}': ${claimed}`;
      }
    }
    const runtime = new TeammateRuntime(this, name, role, prompt, taskId, requirePlan);
    this.#loops.set(name, runtime.start());
    process.stderr.write(`  [teammate] ${name} spawned as ${role}\n`);
    const assigned = taskId ? ` for ${taskId}` : " without an initial Task";
    return `Teammate '${name}' spawned as ${role}${assigned}. `
      + "End this turn; the runtime will deliver its events.";
  }

  async sendMessage(to: string, content: string): Promise<string> {
    if (!this.#status.has(to)) return `Teammate '${to}' is not active`;
    await this.mailbox.send("lead", to, content);
    return `Sent to ${to}`;
  }

  async sendFrom(from: string, to: string, content: string): Promise<string> {
    if (to !== "lead" && !this.#status.has(to)) return `Agent '${to}' is not active`;
    await this.mailbox.send(from, to, content);
    return `Sent to ${to}`;
  }

  async requestShutdown(teammate: string): Promise<string> {
    if (!this.#status.has(teammate)) return `Teammate '${teammate}' is not active`;
    const requestId = this.#newRequestId();
    this.#requests.set(requestId, {
      requestId,
      type: "shutdown",
      sender: "lead",
      target: teammate,
      status: "pending",
      payload: "",
      workVersion: null,
      taskId: null,
    });
    await this.mailbox.send(
      "lead",
      teammate,
      "Finish the current step and shut down.",
      "shutdown_request",
      { request_id: requestId },
    );
    return `Shutdown requested from ${teammate} (${requestId})`;
  }

  async requestPlan(teammate: string, task: string): Promise<string> {
    if (!this.#status.has(teammate)) return `Teammate '${teammate}' is not active`;
    this.assignments.setPlanGate(teammate, "required");
    await this.mailbox.send("lead", teammate, task, "plan_request");
    return `Plan requested from ${teammate}`;
  }

  async reviewPlan(requestId: string, approve: boolean, feedback: string): Promise<string> {
    const decision = await this.assignments.exclusive(() => {
      const state = this.#requests.get(requestId);
      if (!state) return { ok: false as const, message: `Request ${requestId} not found` };
      if (state.type !== "plan_approval") return { ok: false as const, message: `Request ${requestId} is not a plan` };
      if (state.status !== "pending") {
        return { ok: false as const, message: `Request ${requestId} already ${state.status}` };
      }
      const current = this.assignments.identity(state.sender);
      if (state.workVersion !== current.version || state.taskId !== current.taskId) {
        return { ok: false as const, message: `Request ${requestId} belongs to an earlier assignment` };
      }
      if (this.assignments.planRequestId(state.sender) !== requestId) {
        return { ok: false as const, message: `Request ${requestId} is not the current plan` };
      }
      const status = approve ? "approved" as const : "rejected" as const;
      state.status = status;
      return { ok: true as const, sender: state.sender, status };
    });
    if (!decision.ok) return decision.message;
    const content = feedback || (approve ? "Plan approved." : "Revise the plan and submit it again.");
    await this.mailbox.send("lead", decision.sender, content, "plan_approval_response", {
      request_id: requestId,
      approve,
    });
    return `Plan ${decision.status} (${requestId})`;
  }

  createWorktree(name: string, taskId: string): Promise<string> {
    return createTaskWorktree(name, taskId);
  }

  async submitPlan(name: string, plan: string): Promise<string> {
    const requestId = await this.assignments.exclusive(() => {
      if (this.assignments.planGate(name) === "pending") return "";
      const id = this.#newRequestId();
      const current = this.assignments.identity(name);
      this.#requests.set(id, {
        requestId: id,
        type: "plan_approval",
        sender: name,
        target: "lead",
        status: "pending",
        payload: plan,
        workVersion: current.version,
        taskId: current.taskId,
      });
      this.assignments.setPlanGate(name, "pending");
      this.assignments.setPlanRequest(name, id);
      this.markStatus(name, "waiting_approval");
      return id;
    });
    if (!requestId) return "A plan is already waiting for review.";
    await this.mailbox.send(name, "lead", plan, "plan_approval_request", { request_id: requestId });
    return `Plan submitted (${requestId}). Wait for Lead's decision.`;
  }

  takeShutdown(name: string, message: MailMessage): { accepted: boolean; notice: string } {
    const requestId = requestIdOf(message);
    const state = this.#requests.get(requestId);
    const valid = message.from === "lead"
      && message.to === name
      && state !== undefined
      && state.type === "shutdown"
      && state.sender === "lead"
      && state.target === name
      && state.status === "pending"
      && this.#status.get(name) !== "stopping";
    if (!valid) return { accepted: false, notice: "[Ignored shutdown request: request mismatch]" };
    this.markStatus(name, "stopping");
    return { accepted: true, notice: requestId };
  }

  takePlan(name: string, message: MailMessage): Promise<string> {
    return this.assignments.exclusive(() => {
      const requestId = requestIdOf(message);
      const state = this.#requests.get(requestId);
      const current = this.assignments.identity(name);
      const outcome = state?.status;
      const valid = message.from === "lead"
        && message.to === name
        && requestId === this.assignments.planRequestId(name)
        && state !== undefined
        && state.type === "plan_approval"
        && state.sender === name
        && state.target === "lead"
        && state.workVersion === current.version
        && state.taskId === current.taskId
        && (outcome === "approved" || outcome === "rejected")
        && (message.metadata.approve === true) === (outcome === "approved");
      if (!valid || (outcome !== "approved" && outcome !== "rejected")) {
        return "[Ignored plan response: request mismatch]";
      }
      const gate: PlanGate = outcome;
      this.assignments.setPlanGate(name, gate);
      this.markStatus(name, "working");
      this.assignments.setPlanRequest(name, undefined);
      return `[Plan ${outcome}] ${message.content}`;
    });
  }

  async consumeLead(): Promise<string | null> {
    const messages = await this.mailbox.read("lead");
    if (messages.length === 0) return null;
    for (const message of messages) {
      const requestId = requestIdOf(message);
      if (requestId && message.type.endsWith("_response")) {
        this.#matchResponse(message.type, requestId, message.metadata.approve === true, message.from, message.to);
      }
    }
    process.stderr.write(`  [wake] ${messages.length} team event(s)\n`);
    return formatTeamEvents(messages);
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    const pending = [...this.#loops.values()];
    await Promise.race([
      Promise.all(pending.map((done) => done.catch(() => undefined))),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 1000).unref();
      }),
    ]);
  }

  async claimNext(name: string): Promise<Task | null> {
    if (this.assignments.hasLease(name) || await this.assignments.tasks.ownerInProgress(name)) return null;
    for (const task of await this.assignments.tasks.list()) {
      if (task.status !== "pending" || task.owner !== null) continue;
      if (!(await this.assignments.tasks.isReady(task))) continue;
      const claimed = await this.assignments.claim(task.id, name);
      if (claimed.startsWith("Claimed ")) return this.assignments.tasks.load(task.id);
    }
    return null;
  }

  #newRequestId(): string {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const requestId = `req_${Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0")}`;
      if (!this.#requests.has(requestId)) return requestId;
    }
    throw new Error("Could not allocate a request ID");
  }

  #matchResponse(
    responseType: string,
    requestId: string,
    approve: boolean,
    fromAgent: string,
    toAgent: string,
  ): boolean {
    const state = this.#requests.get(requestId);
    if (!state) {
      process.stderr.write(`  [protocol] unknown request_id: ${requestId}\n`);
      return false;
    }
    const expected = state.type === "shutdown" ? "shutdown_response" : "plan_approval_response";
    if (responseType !== expected) {
      process.stderr.write(`  [protocol] expected ${expected}, got ${responseType}\n`);
      return false;
    }
    if (fromAgent !== state.target || toAgent !== state.sender) {
      process.stderr.write(`  [protocol] ${requestId} responder mismatch\n`);
      return false;
    }
    if (state.status !== "pending") {
      process.stderr.write(`  [protocol] ${requestId} already ${state.status}\n`);
      return false;
    }
    state.status = approve ? "approved" : "rejected";
    process.stderr.write(`  [protocol] ${requestId} -> ${state.status}\n`);
    return true;
  }
}

class TeammateRuntime {
  readonly name: string;
  #host: TeamHost;
  #prompt: string;
  #taskId: string | null;
  #requirePlan: boolean;
  #system: string;
  #messages: OpenAI.Responses.ResponseInput = [];
  #rounds = 0;
  // The opening assignment already prompted this task. Wait for mail before asking again.
  #idleTask: string | null = null;

  constructor(
    host: TeamHost,
    name: string,
    role: string,
    prompt: string,
    taskId: string | null,
    requirePlan: boolean,
  ) {
    this.#host = host;
    this.name = name;
    this.#prompt = prompt;
    this.#taskId = taskId;
    this.#requirePlan = requirePlan;
    this.#system = [
      `You are '${name}', a ${role}.`,
      "Use tools to complete the assigned task, then call complete_task and report a concise result.",
      "If the first user message contains [Assigned task], that task is already claimed; do not call claim_task for it again.",
      "When asked for a plan, call submit_plan and wait for approval before bash or file changes.",
      "File and shell tools use the task's working directory. That directory is not a sandbox.",
      "The runtime delivers your final text to the lead.",
      "Use send_message only for intermediate coordination, and address the coordinator as 'lead'.",
    ].join(" ");
  }

  start(): Promise<void> {
    return this.#start();
  }

  async #start(): Promise<void> {
    const host = this.#host;
    try {
      let content = this.#prompt;
      if (this.#taskId) {
        const task = await host.assignments.tasks.load(this.#taskId);
        const cwd = await host.assignments.workingDirectory(this.name);
        content += `\n\n[Assigned task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}`;
        this.#idleTask = task.id;
      }
      if (this.#requirePlan) {
        content += "\n\n[Plan required] Submit a plan and wait for Lead approval "
          + "before changing files or using bash.";
      }
      this.#messages.push({ role: "developer", content: this.#system });
      this.#messages.push({ role: "user", content });
      let state: LoopState = "continue";
      while (state !== "stop" && !host.signal.aborted) {
        if (state === "idle" && !(await this.#waitForWork())) break;
        if (host.signal.aborted) break;
        state = await this.#work();
      }
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      await host.mailbox.send(this.name, "lead", `${errorName}: ${message}`, "error").catch(() => undefined);
    } finally {
      try {
        await host.assignments.releaseTeammate(this.name);
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "Error";
        const message = error instanceof Error ? error.message : String(error);
        await host.mailbox.send(
          this.name,
          "lead",
          `Assignment cleanup failed: ${errorName}: ${message}`,
          "error",
        ).catch(() => undefined);
      }
      host.finish(this.name);
      process.stderr.write(`  [teammate] ${this.name} finished\n`);
    }
  }

  async #waitForWork(): Promise<boolean> {
    const host = this.#host;
    while (!host.signal.aborted) {
      const inbox = await waitForInbox(host.mailbox, this.name, host.signal);
      if (inbox.length > 0) {
        const before = this.#messages.length;
        if (await this.#handleInbox(inbox)) return false;
        if (this.#messages.length > before) return true;
        continue;
      }
      if (host.signal.aborted) return false;
      if (host.assignments.planGate(this.name) === "pending") continue;
      let task: Task | null = await host.assignments.tasks.ownerInProgress(this.name);
      const resuming = task !== null;
      if (task && task.id === this.#idleTask) continue;
      if (!task) task = await host.claimNext(this.name);
      if (!task) continue;
      let cwd: string;
      try {
        cwd = await host.assignments.workingDirectory(this.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await host.mailbox.send(this.name, "lead", `Invalid task assignment: ${message}`, "error");
        return false;
      }
      this.#idleTask = task.id;
      this.#messages.push({
        role: "user",
        content: `[${resuming ? "Resume" : "Auto-claimed"} task ${task.id}] ${task.subject}\n`
          + `${task.description}\nWork directory: ${cwd}`,
      });
      const action = resuming ? "resuming" : "claimed";
      process.stderr.write(`  [idle] ${this.name} ${action} ${task.id}: ${task.subject}\n`);
      return true;
    }
    return false;
  }

  async #handleInbox(inbox: readonly MailMessage[]): Promise<boolean> {
    const host = this.#host;
    const notes: string[] = [];
    for (const message of inbox) {
      if (message.type === "shutdown_request") {
        const decision = host.takeShutdown(this.name, message);
        if (!decision.accepted) {
          notes.push(decision.notice);
          continue;
        }
        await host.mailbox.send(this.name, "lead", "Shutdown acknowledged.", "shutdown_response", {
          request_id: decision.notice,
          approve: true,
        });
        return true;
      }
      if (message.type === "plan_approval_response") {
        notes.push(await host.takePlan(this.name, message));
        continue;
      }
      if (message.type === "plan_request") {
        notes.push(`[Plan required] ${message.content}`);
        continue;
      }
      notes.push(`[Message from ${message.from}] ${message.content}`);
    }
    if (notes.length > 0) this.#messages.push({ role: "user", content: notes.join("\n") });
    return false;
  }

  async #work(): Promise<LoopState> {
    const host = this.#host;
    if (await this.#handleInbox(await host.mailbox.read(this.name))) return "stop";
    host.markStatus(this.name, "working");
    let output: OpenAI.Responses.ResponseOutputItem[];
    try {
      ({ output } = await host.ask(this.#messages, teammateTools));
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      await host.mailbox.send(this.name, "lead", `${errorName}: ${message}`, "error");
      return "stop";
    }
    this.#messages.push(...toResponseInputItems(output));
    const calls = output.filter(isFunctionCall);
    if (calls.length > 0) {
      this.#rounds += 1;
      if (this.#rounds > maxToolRounds) {
        await host.mailbox.send(this.name, "lead", `Stopped after ${maxToolRounds} tool rounds.`, "error");
        return "stop";
      }
      for (const call of calls) {
        this.#messages.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: await this.#runTool(call.name, call.arguments),
        });
      }
      return "continue";
    }
    const summary = finalText(output);
    const gate = host.assignments.planGate(this.name);
    if (gate !== "pending" && summary) await host.mailbox.send(this.name, "lead", summary, "result");
    if (gate === "pending") host.markStatus(this.name, "waiting_approval");
    else {
      await host.assignments.releaseCompleted(this.name);
      host.markStatus(this.name, "idle");
      await host.mailbox.send(this.name, "lead", "Waiting for more work.", "idle_notification");
      this.#rounds = 0;
    }
    return "idle";
  }

  async #runTool(name: string, rawArgs: string): Promise<string> {
    let args: unknown;
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return "Error: tool arguments are not valid JSON";
    }
    try {
      return await this.#dispatch(name, args);
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${errorName}: ${message}`;
    }
  }

  async #dispatch(name: string, args: unknown): Promise<string> {
    const host = this.#host;
    if (!isRecord(args)) throw new Error(`${name} expects a JSON object.`);
    if (mutatingTools.has(name)) {
      const gate = host.assignments.planGate(this.name);
      if (gate !== "approved" && gate !== "not_required") {
        return `Blocked: plan status is ${gate}. Submit or revise the plan and `
          + "wait for approval before changing the workspace.";
      }
    }
    if (workspaceTools.has(name)) {
      if (!host.assignments.hasLease(this.name)) return "Error: Claim a Task before using workspace tools.";
      let cwd: string;
      try {
        cwd = await host.assignments.workingDirectory(this.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error: Invalid task assignment: ${message}`;
      }
      return runWorkspace(name, args, cwd);
    }
    if (name === "send_message") {
      return host.sendFrom(this.name, stringField(args, "to", name), stringField(args, "content", name));
    }
    if (name === "submit_plan") return host.submitPlan(this.name, stringField(args, "plan", name));
    if (name === "list_tasks") return formatTaskList(await host.assignments.tasks.list());
    if (name === "claim_task") return host.assignments.claim(stringField(args, "task_id", name), this.name);
    if (name === "complete_task") {
      return host.assignments.completeFor(this.name, stringField(args, "task_id", name));
    }
    return `Unknown tool: ${name}`;
  }
}

export const teamHost = new TeamHost(liveAssignments, liveMailbox, defaultAsk);
