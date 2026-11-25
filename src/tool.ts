import { AsyncLocalStorage } from "node:async_hooks";
import { exec } from "node:child_process";
import { glob, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { assignments } from "./assignments.ts";
import { AGENT_CONTEXT_FILE, project } from "./config.ts";
import { isContextOverflow, maxReactiveRetries, prepare, reactiveCompact } from "./compact.ts";
import { request } from "./llm.ts";
import { triggerHooks, type PreToolUseCall } from "./hooks/core.ts";
import { mcpRegistry } from "./mcp.ts";
import { teammatePermission } from "./permission.ts";
import { startBackgroundBash } from "./background.ts";
import { cronScheduler, formatCronList, formatScheduled } from "./cron.ts";
import {
  formatCreated,
  formatTask,
  formatTaskList,
  formatUpdated,
  taskStore,
} from "./tasks.ts";
import {
  createWorktreeTool,
  installWorkspaceRunner,
  leadSendTool,
  listTeammatesTool,
  requestPlanTool,
  requestShutdownTool,
  reviewPlanTool,
  spawnTeammateTool,
  teamHost,
  teamTools,
} from "./team.ts";
import { runWorkflow, WorkflowInputError, workflowTool } from "./workflow.ts";

const maxOutputBytes = 50_000;
const timeoutMs = 120_000;
const maxGlobMatches = 200;

// Set only while a tool call is bound to a task worktree. Unset keeps project-relative tools.
const toolBase = new AsyncLocalStorage<string>();

function toolRoot(): string {
  return toolBase.getStore() ?? project;
}

export function withToolBase<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  return toolBase.run(cwd, action);
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

export const bashTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "bash",
  description: "Run a shell command in the project. "
    + "Set run_in_background to true only for an independent command; "
    + "its result arrives on a later turn. "
    + "A foreground command returns JSON with exit_code, stdout, stderr, and truncation status.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      run_in_background: { type: "boolean" },
    },
    required: ["command", "run_in_background"],
    additionalProperties: false,
  },
  strict: true,
};

export const readFileTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "read_file",
  description: "Read a UTF-8 text file in the project. Pass limit to keep only the first N lines. "
    + "Paths outside the project require user approval. Returns JSON with content and truncation status.",
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

export const writeFileTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "write_file",
  description: "Write content to a file in the project, creating parent directories as needed. "
    + "Paths outside the project require user approval. Returns JSON with path and byte count.",
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

export const editFileTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "edit_file",
  description: "Replace the first occurrence of old_text with new_text in a project file. "
    + "Fails when old_text is absent. Paths outside the project require user approval.",
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

export const globTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "glob",
  description: "Find project files matching a glob pattern; ** matches recursively. "
    + "Matches are confined to the project. Returns up to 200 sorted matches.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  strict: true,
};

export const todoWriteTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "todo_write",
  description: "Create and manage a task list for the current session. "
    + "Plan multi-step work up front and keep exactly one task in_progress.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1 },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  strict: true,
};

// -- Skills: catalog in the system prompt, full content via load_skill --

const skillsDir = resolve(project, "skills");

interface Skill {
  name: string;
  description: string;
  content: string;
}

function parseFrontmatter(text: string): { metadata: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) return { metadata: {}, body: text };
  const metadata: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (pair) metadata[pair[1]] = pair[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return { metadata, body: match[2].trim() };
}

async function scanSkills(): Promise<Skill[]> {
  const skills: Skill[] = [];
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let content: string;
    try {
      content = await readFile(resolve(skillsDir, entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const { metadata, body } = parseFrontmatter(content);
    const name = metadata.name?.trim() || entry.name;
    const description = (metadata.description?.trim()
      || body.split("\n", 1)[0].replace(/^#+\s*/, "")).replace(/\s+/g, " ").trim();
    skills.push({ name, description, content });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export const skills = await scanSkills();

export function skillCatalog(): string {
  if (!skills.length) return "(no skills found)";
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}

export const loadSkillTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "load_skill",
  description: "Load the full SKILL.md content for a skill by name. "
    + "The available skills are listed in the system prompt.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  strict: true,
};

async function executeLoadSkill(input: unknown): Promise<string> {
  const record = asRecord(input, "load_skill");
  const name = stringArg(record, "name", "load_skill").trim();
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) {
    const available = skills.map((candidate) => candidate.name).join(", ") || "none";
    throw new Error(`Unknown skill '${name}'. Available: ${available}`);
  }
  return skill.content;
}

export const tools = [bashTool, readFileTool, writeFileTool, editFileTool, globTool, todoWriteTool, loadSkillTool];

export type ToolHandler = (input: unknown) => Promise<string>;

function asRecord(input: unknown, name: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${name} expects a JSON object.`);
  }
  return input as Record<string, unknown>;
}

function stringArg(record: Record<string, unknown>, key: string, name: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${name} expects ${key} to be a string without NUL bytes.`);
  }
  return value;
}

function booleanArg(record: Record<string, unknown>, key: string, name: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`${name} expects ${key} to be a boolean.`);
  return value;
}

function pathArg(record: Record<string, unknown>, name: string): string {
  const path = stringArg(record, "path", name);
  if (!path) throw new Error(`${name} expects a non-empty path.`);
  const root = toolRoot();
  const full = resolve(root, path);
  if (toolBase.getStore() !== undefined) {
    const rel = relative(root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path escapes the working directory: ${path}`);
    }
  }
  return full;
}

async function executeBash(input: unknown): Promise<string> {
  const record = asRecord(input, "bash");
  if (typeof record.run_in_background !== "boolean") {
    throw new Error("bash expects run_in_background to be a boolean.");
  }
  if (record.run_in_background) {
    throw new Error("Only the parent agent can run bash in the background.");
  }
  const command = stringArg(record, "command", "bash");
  if (!command.trim()) throw new Error("bash expects a non-empty command.");
  return new Promise((resolveResult) => {
    const child = exec(command, {
      cwd: toolRoot(),
      env: process.env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: maxOutputBytes,
      encoding: "buffer",
    }, (error, stdout, stderr) => {
      const stdoutBytes = stdout.subarray(0, maxOutputBytes);
      const stderrBytes = stderr.subarray(0, maxOutputBytes - stdoutBytes.length);
      const truncated = stdout.length + stderr.length > maxOutputBytes
        || String(error?.code) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
      let failure: string | undefined;
      if (truncated) failure = `Output exceeded ${maxOutputBytes} bytes.`;
      else if (error?.killed) failure = `Command timed out after ${timeoutMs / 1000} seconds.`;
      else if (error && exitCode === null) {
        failure = `Could not run the command (${error.code ?? error.signal ?? "unknown error"}).`;
      }
      resolveResult(JSON.stringify({
        exit_code: exitCode,
        stdout: stdoutBytes.toString("utf8"),
        stderr: stderrBytes.toString("utf8"),
        truncated,
        error: failure,
      }));
    });
    child.stdin?.end();
  });
}

async function executeReadFile(input: unknown): Promise<string> {
  const record = asRecord(input, "read_file");
  const limit = record.limit;
  if (limit !== null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) {
    throw new Error("read_file expects limit to be a positive integer or null.");
  }
  const text = await readFile(pathArg(record, "read_file"), "utf8");
  let lines = text.split("\n");
  let truncated = false;
  if (typeof limit === "number" && limit < lines.length) {
    lines = lines.slice(0, limit);
    truncated = true;
  }
  const buffer = Buffer.from(lines.join("\n"), "utf8");
  truncated ||= buffer.length > maxOutputBytes;
  return JSON.stringify({ content: buffer.subarray(0, maxOutputBytes).toString("utf8"), truncated });
}

async function executeWriteFile(input: unknown): Promise<string> {
  const record = asRecord(input, "write_file");
  const full = pathArg(record, "write_file");
  const content = stringArg(record, "content", "write_file");
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  return JSON.stringify({ path: relative(project, full), bytes: Buffer.byteLength(content, "utf8") });
}

async function executeEditFile(input: unknown): Promise<string> {
  const record = asRecord(input, "edit_file");
  const full = pathArg(record, "edit_file");
  const oldText = stringArg(record, "old_text", "edit_file");
  const newText = stringArg(record, "new_text", "edit_file");
  if (!oldText) throw new Error("edit_file expects a non-empty old_text.");
  const text = await readFile(full, "utf8");
  if (!text.includes(oldText)) {
    throw new Error(`edit_file could not find old_text in ${relative(project, full)}.`);
  }
  await writeFile(full, text.replace(oldText, newText), "utf8");
  return JSON.stringify({ path: relative(project, full), edited: true });
}

async function executeGlob(input: unknown): Promise<string> {
  const record = asRecord(input, "glob");
  const pattern = stringArg(record, "pattern", "glob");
  if (!pattern || isAbsolute(pattern)) throw new Error("glob expects a relative, non-empty pattern.");
  const root = toolRoot();
  const matches = new Set<string>();
  for await (const match of glob(pattern, { cwd: root })) {
    const rel = relative(root, resolve(root, match));
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    matches.add(rel);
  }
  const sorted = [...matches].sort();
  const truncated = sorted.length > maxGlobMatches;
  return JSON.stringify({ matches: truncated ? sorted.slice(0, maxGlobMatches) : sorted, truncated });
}

// -- Structured state the model updates --

const todoStatuses = ["pending", "in_progress", "completed"] as const;
type TodoStatus = (typeof todoStatuses)[number];
interface TodoItem {
  content: string;
  status: TodoStatus;
}

let todos: TodoItem[] = [];

function renderTodos(): string {
  if (!todos.length) return "No todos.";
  const markers: Record<TodoStatus, string> = {
    pending: "[ ]",
    in_progress: "[>]",
    completed: "[x]",
  };
  const lines = todos.map((todo) => `${markers[todo.status]} ${todo.content}`);
  const done = todos.filter((todo) => todo.status === "completed").length;
  lines.push(`\n(${done}/${todos.length} completed)`);
  return lines.join("\n");
}

async function executeTodoWrite(input: unknown): Promise<string> {
  const record = asRecord(input, "todo_write");
  if (!Array.isArray(record.todos)) throw new Error("todo_write expects todos to be an array.");
  if (record.todos.length > 20) throw new Error("todo_write allows at most 20 todos.");
  const validated: TodoItem[] = [];
  let inProgress = 0;
  for (const [index, item] of record.todos.entries()) {
    const todo = asRecord(item, `todos[${index}]`);
    const content = stringArg(todo, "content", `todos[${index}]`).trim();
    if (!content) throw new Error(`todos[${index}] requires content.`);
    const status = stringArg(todo, "status", `todos[${index}]`);
    if (!todoStatuses.includes(status as TodoStatus)) {
      throw new Error(`todos[${index}] has invalid status '${status}'.`);
    }
    if (status === "in_progress") inProgress += 1;
    validated.push({ content, status: status as TodoStatus });
  }
  if (inProgress > 1) throw new Error("Only one todo can be in_progress at a time.");
  todos = validated;
  return renderTodos();
}

export const toolHandlers: Record<string, ToolHandler> = {
  [bashTool.name]: executeBash,
  [readFileTool.name]: executeReadFile,
  [writeFileTool.name]: executeWriteFile,
  [editFileTool.name]: executeEditFile,
  [globTool.name]: executeGlob,
  [todoWriteTool.name]: executeTodoWrite,
  [loadSkillTool.name]: executeLoadSkill,
};

export async function executeTool(
  call: OpenAI.Responses.ResponseFunctionToolCall,
  handlers: Record<string, ToolHandler> = toolHandlers,
): Promise<OpenAI.Responses.ResponseInputItem.FunctionCallOutput> {
  const hookCall: PreToolUseCall = { name: call.name, args: undefined, argsJson: call.arguments };
  let output: string;
  let blocked = false;
  try {
    const handler = handlers[call.name];
    if (!handler) throw new Error(`Unknown tool ${call.name}`);
    const args: unknown = JSON.parse(call.arguments);
    hookCall.args = args;
    const deny = await triggerHooks("PreToolUse", hookCall);
    if (deny !== undefined) {
      blocked = true;
      throw new Error(deny);
    }
    output = await handler(args);
  } catch (error) {
    output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
  if (!blocked) await triggerHooks("PostToolUse", { ...hookCall, output });
  return { type: "function_call_output", call_id: call.call_id, output };
}

// -- Subagent: the task tool runs a nested agent loop with fresh messages --

const maxSubagentRounds = 30;

export const compactTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "compact",
  description: "Summarize earlier conversation to free context space.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  strict: true,
};

export const taskTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "task",
  description: "Run a subagent with fresh conversation context and return its final text. "
    + "Use for focused exploration or a self-contained subtask.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1 },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  strict: true,
};

const subagentContext = [
  "You are a terminal assistant. Reply in the user's language.",
  "Destructive or out-of-project tool calls need no hesitation: request them, "
    + "and the harness will ask the user for approval before running them.",
  "Complete the given task, then return a concise final answer. "
    + "You have no task tool, no task-record tools, no cron tools, no team tools, no MCP tools, and no workflow tool; do the work yourself. "
    + "Set bash run_in_background to false.",
  "",
  "Skills available:",
  skillCatalog(),
  "Use load_skill to read the full instructions when a skill applies.",
  ...(AGENT_CONTEXT_FILE ? ["", await readFile(AGENT_CONTEXT_FILE, "utf8")] : []),
].join("\n");

function finalText(output: OpenAI.Responses.ResponseOutputItem[]): string {
  return output
    .flatMap((item) => (item.type === "message" ? item.content : []))
    .map((part) => (part.type === "output_text" ? part.text : part.refusal))
    .join("")
    .trim();
}

// The subagent gets the base tools only, so it cannot delegate again.
async function runSubagent(prompt: string): Promise<string> {
  let messages: OpenAI.Responses.ResponseInput = [
    { role: "developer", content: subagentContext },
    { role: "user", content: prompt },
  ];
  let reactiveRetries = 0;
  for (let round = 0; ; round++) {
    messages = await prepare(messages, prompt);
    let output: OpenAI.Responses.ResponseOutputItem[];
    try {
      ({ output } = await request(messages, tools, () => {}));
      reactiveRetries = 0;
    } catch (error) {
      if (isContextOverflow(error) && reactiveRetries < maxReactiveRetries) {
        messages = await reactiveCompact(messages, prompt);
        reactiveRetries += 1;
        continue;
      }
      throw error;
    }
    messages.push(...toResponseInputItems(output));
    const calls = output.filter((item) => item.type === "function_call");
    if (!calls.length) {
      const force = round < maxSubagentRounds ? await triggerHooks("Stop", messages) : undefined;
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return finalText(output) || "(no summary)";
    }
    if (round === maxSubagentRounds) {
      return `Subagent stopped after ${maxSubagentRounds} tool rounds without a final answer.`;
    }
    for (const call of calls) messages.push(await executeTool(call));
  }
}

export const createTaskTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "create_task",
  description: "Create a persistent task and return its runtime-generated ID. "
    + "Create every task node before adding dependencies. Do not invent task IDs.",
  parameters: {
    type: "object",
    properties: {
      subject: { type: "string", minLength: 1 },
      description: { type: "string" },
    },
    required: ["subject", "description"],
    additionalProperties: false,
  },
  strict: true,
};

export const updateTaskTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "update_task",
  description: "Add dependencies using IDs returned by create_task. "
    + "Only a pending, unowned task can gain dependencies.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", pattern: "^task_[0-9a-f]{8}$" },
      addBlockedBy: {
        type: "array",
        minItems: 1,
        items: { type: "string", pattern: "^task_[0-9a-f]{8}$" },
      },
    },
    required: ["task_id", "addBlockedBy"],
    additionalProperties: false,
  },
  strict: true,
};

export const listTasksTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "list_tasks",
  description: "List tasks with status, owner, dependencies, and worktree.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  strict: true,
};

export const getTaskTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "get_task",
  description: "Get a task by ID.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", pattern: "^task_[0-9a-f]{8}$" },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
  strict: true,
};

export const claimTaskTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "claim_task",
  description: "Claim a pending task whose dependencies are complete.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", pattern: "^task_[0-9a-f]{8}$" },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
  strict: true,
};

export const completeTaskTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "complete_task",
  description: "Complete the task claimed by this agent.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", pattern: "^task_[0-9a-f]{8}$" },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
  strict: true,
};

const taskRecordTools = [
  createTaskTool,
  updateTaskTool,
  listTasksTool,
  getTaskTool,
  claimTaskTool,
  completeTaskTool,
];

async function executeCreateTask(input: unknown): Promise<string> {
  const record = asRecord(input, "create_task");
  const task = await taskStore.create(
    stringArg(record, "subject", "create_task"),
    stringArg(record, "description", "create_task"),
  );
  return formatCreated(task);
}

async function executeUpdateTask(input: unknown): Promise<string> {
  const record = asRecord(input, "update_task");
  if (!Array.isArray(record.addBlockedBy) || record.addBlockedBy.length === 0) {
    throw new Error("update_task expects addBlockedBy to be a non-empty list of task IDs.");
  }
  const addBlockedBy: string[] = [];
  for (const item of record.addBlockedBy) {
    if (typeof item !== "string" || item.includes("\0")) {
      throw new Error("update_task expects addBlockedBy to be a non-empty list of task IDs.");
    }
    addBlockedBy.push(item);
  }
  const task = await taskStore.updateDependencies(
    stringArg(record, "task_id", "update_task"),
    addBlockedBy,
  );
  return formatUpdated(task);
}

async function executeListTasks(): Promise<string> {
  return formatTaskList(await taskStore.list());
}

async function executeGetTask(input: unknown): Promise<string> {
  const record = asRecord(input, "get_task");
  return formatTask(await taskStore.load(stringArg(record, "task_id", "get_task")));
}

async function executeClaimTask(input: unknown): Promise<string> {
  const record = asRecord(input, "claim_task");
  return assignments.claim(stringArg(record, "task_id", "claim_task"), "agent");
}

async function executeCompleteTask(input: unknown): Promise<string> {
  const record = asRecord(input, "complete_task");
  return assignments.completeFor("agent", stringArg(record, "task_id", "complete_task"));
}

async function boundToAssignment(handler: ToolHandler, input: unknown): Promise<string> {
  const cwd = await assignments.workingDirectory("agent");
  if (await sameDirectory(cwd, project)) return handler(input);
  return withToolBase(cwd, () => handler(input));
}

export const progressToolNames: ReadonlySet<string> = new Set([
  todoWriteTool.name,
  createTaskTool.name,
  updateTaskTool.name,
  claimTaskTool.name,
  completeTaskTool.name,
]);

async function executeParentBash(input: unknown): Promise<string> {
  const record = asRecord(input, "bash");
  const cwd = await assignments.workingDirectory("agent");
  if (record.run_in_background === true) {
    const command = stringArg(record, "command", "bash");
    const taskId = startBackgroundBash(command, timeoutMs, cwd);
    return `[Background task ${taskId} started] The result will be collected on a later turn.`;
  }
  if (await sameDirectory(cwd, project)) return executeBash(input);
  return withToolBase(cwd, () => executeBash(input));
}

async function executeSpawnTeammate(input: unknown): Promise<string> {
  const record = asRecord(input, "spawn_teammate");
  const taskId = stringArg(record, "task_id", "spawn_teammate").trim();
  return teamHost.spawn(
    stringArg(record, "name", "spawn_teammate"),
    stringArg(record, "role", "spawn_teammate"),
    stringArg(record, "prompt", "spawn_teammate"),
    taskId === "" ? null : taskId,
    booleanArg(record, "require_plan", "spawn_teammate"),
  );
}

async function executeLeadSend(input: unknown): Promise<string> {
  const record = asRecord(input, "send_message");
  return teamHost.sendMessage(stringArg(record, "to", "send_message"), stringArg(record, "content", "send_message"));
}

async function executeRequestShutdown(input: unknown): Promise<string> {
  const record = asRecord(input, "request_shutdown");
  return teamHost.requestShutdown(stringArg(record, "teammate", "request_shutdown"));
}

async function executeRequestPlan(input: unknown): Promise<string> {
  const record = asRecord(input, "request_plan");
  return teamHost.requestPlan(
    stringArg(record, "teammate", "request_plan"),
    stringArg(record, "task", "request_plan"),
  );
}

async function executeReviewPlan(input: unknown): Promise<string> {
  const record = asRecord(input, "review_plan");
  return teamHost.reviewPlan(
    stringArg(record, "request_id", "review_plan"),
    booleanArg(record, "approve", "review_plan"),
    stringArg(record, "feedback", "review_plan"),
  );
}

async function executeCreateWorktree(input: unknown): Promise<string> {
  const record = asRecord(input, "create_worktree");
  return teamHost.createWorktree(
    stringArg(record, "name", "create_worktree"),
    stringArg(record, "task_id", "create_worktree"),
  );
}

export const scheduleCronTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "schedule_cron",
  description: "Schedule a prompt with a 5-field cron expression in local time: "
    + "minute hour day-of-month month day-of-week. "
    + "The prompt runs on a later turn when the agent is idle. "
    + "recurring keeps the job after it runs. durable keeps it across restarts.",
  parameters: {
    type: "object",
    properties: {
      cron: { type: "string" },
      prompt: { type: "string" },
      recurring: { type: "boolean" },
      durable: { type: "boolean" },
    },
    required: ["cron", "prompt", "recurring", "durable"],
    additionalProperties: false,
  },
  strict: true,
};

export const listCronsTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "list_crons",
  description: "List scheduled cron jobs.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  strict: true,
};

export const cancelCronTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "cancel_cron",
  description: "Cancel a cron job by ID.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string" },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
  strict: true,
};

async function executeScheduleCron(input: unknown): Promise<string> {
  const record = asRecord(input, "schedule_cron");
  const job = await cronScheduler.schedule({
    cron: stringArg(record, "cron", "schedule_cron"),
    prompt: stringArg(record, "prompt", "schedule_cron"),
    recurring: booleanArg(record, "recurring", "schedule_cron"),
    durable: booleanArg(record, "durable", "schedule_cron"),
  });
  return formatScheduled(job);
}

async function executeListCrons(): Promise<string> {
  return formatCronList(await cronScheduler.list());
}

async function executeCancelCron(input: unknown): Promise<string> {
  const record = asRecord(input, "cancel_cron");
  return cronScheduler.cancel(stringArg(record, "job_id", "cancel_cron"));
}

export const connectMcpTool: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "connect_mcp",
  description: "Connect to an MCP server and discover its tools.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", enum: ["docs", "deploy"] },
    },
    required: ["name"],
    additionalProperties: false,
  },
  strict: true,
};

async function executeConnectMcp(input: unknown): Promise<string> {
  const record = asRecord(input, "connect_mcp");
  const reserved = new Set(parentTools.map((tool) => tool.name));
  return mcpRegistry.connect(stringArg(record, "name", "connect_mcp"), reserved);
}

async function executeWorkflow(input: unknown): Promise<string> {
  const record = asRecord(input, "Workflow");
  const budget = record.budget;
  if (budget !== null && (typeof budget !== "number" || !Number.isFinite(budget))) {
    return "Error: args.budget must be a number or null";
  }
  const resume = stringArg(record, "resume_from_run_id", "Workflow").trim();
  try {
    const result = await runWorkflow({
      name: stringArg(record, "name", "Workflow"),
      args: { changes: stringArg(record, "changes", "Workflow"), budget },
      resumeFromRunId: resume === "" ? null : resume,
    });
    return JSON.stringify(result, null, 2);
  } catch (error) {
    if (error instanceof WorkflowInputError) return `Error: ${error.message}`;
    throw error;
  }
}

export const parentTools = [
  ...tools,
  connectMcpTool,
  ...taskRecordTools,
  taskTool,
  compactTool,
  scheduleCronTool,
  listCronsTool,
  cancelCronTool,
  ...teamTools,
  workflowTool,
];
export const parentHandlers: Record<string, ToolHandler> = {
  ...toolHandlers,
  [bashTool.name]: executeParentBash,
  [readFileTool.name]: (input) => boundToAssignment(executeReadFile, input),
  [writeFileTool.name]: (input) => boundToAssignment(executeWriteFile, input),
  [editFileTool.name]: (input) => boundToAssignment(executeEditFile, input),
  [globTool.name]: (input) => boundToAssignment(executeGlob, input),
  [scheduleCronTool.name]: executeScheduleCron,
  [listCronsTool.name]: executeListCrons,
  [cancelCronTool.name]: executeCancelCron,
  [connectMcpTool.name]: executeConnectMcp,
  [createTaskTool.name]: executeCreateTask,
  [updateTaskTool.name]: executeUpdateTask,
  [listTasksTool.name]: executeListTasks,
  [getTaskTool.name]: executeGetTask,
  [claimTaskTool.name]: executeClaimTask,
  [completeTaskTool.name]: executeCompleteTask,
  [spawnTeammateTool.name]: executeSpawnTeammate,
  [listTeammatesTool.name]: async () => teamHost.list(),
  [leadSendTool.name]: executeLeadSend,
  [requestShutdownTool.name]: executeRequestShutdown,
  [requestPlanTool.name]: executeRequestPlan,
  [reviewPlanTool.name]: executeReviewPlan,
  [createWorktreeTool.name]: executeCreateWorktree,
  [workflowTool.name]: executeWorkflow,
  [taskTool.name]: async (input) => {
    const record = asRecord(input, "task");
    const prompt = stringArg(record, "prompt", "task").trim();
    if (!prompt) throw new Error("task expects a non-empty prompt string.");
    return runSubagent(prompt);
  },
};

export function leadToolPool(): {
  tools: OpenAI.Responses.FunctionTool[];
  handlers: Record<string, ToolHandler>;
} {
  const reserved = new Set(parentTools.map((tool) => tool.name));
  return {
    tools: [...parentTools, ...mcpRegistry.toolDefinitions(reserved)],
    handlers: { ...parentHandlers, ...mcpRegistry.handlers() },
  };
}

installWorkspaceRunner(async (name, args, cwd) => {
  const denied = teammatePermission(name, args, cwd);
  if (denied) return denied;
  const handler = toolHandlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  const input = name === bashTool.name && args !== null && typeof args === "object" && !Array.isArray(args)
    ? { ...args, run_in_background: false }
    : args;
  return withToolBase(cwd, () => handler(input));
});
