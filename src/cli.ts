import { createInterface } from "node:readline";
import {
  consumedScheduledWork,
  runBackgroundResume,
  runScheduledTurn,
  runTeamTurn,
  runTurn,
  shouldResumeGoalForBackground,
  transcript,
} from "./agent.ts";
import { hasBackgroundResult, hasRunningBackground, waitForBackgroundIdle } from "./background.ts";
import { cronScheduler } from "./cron.ts";
import { createPermissionHook } from "./hooks/builtins.ts";
import { registerHook } from "./hooks/core.ts";
import { teamHost } from "./team.ts";
import { taskTool } from "./tool.ts";

const { stdin, stdout, stderr } = process;
using lines = createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const interactive = stdin.isTTY && stdout.isTTY;

type BufferedLine =
  | { done: true }
  | { done: false; line: string };

let buffered: BufferedLine | null = null;
let inflight: Promise<void> | null = null;
let promptShown = false;
let scheduleNotBefore = 0;

function takeAnswer(): string | null {
  const next = buffered;
  if (!next || next.done) return null;
  buffered = null;
  return next.line;
}

async function confirm(reason: string, name: string, argsJson: string): Promise<boolean> {
  // A line already waiting is the user's next command, not this approval.
  if (buffered && !buffered.done) return false;
  if (promptShown) {
    stdout.write("\n");
    promptShown = false;
  }
  stdout.write(`\n[permission] ${reason}\n   Tool: ${name}(${argsJson})\n   Allow? [y/N] `);
  ensureRead();
  if (inflight) await inflight;
  const line = takeAnswer();
  if (line === null) return false;
  const answer = line.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

registerHook("PreToolUse", createPermissionHook(confirm));

// Subagent observability: a task call brackets the inner loop's tool activity.
let subagentDepth = 0;

registerHook("PreToolUse", ({ name }) => {
  if (name === taskTool.name) {
    subagentDepth += 1;
    stdout.write("\n\x1b[35m[Subagent started]\x1b[0m\n");
  }
  return undefined;
});

registerHook("PostToolUse", ({ name, output }) => {
  if (name === taskTool.name) {
    subagentDepth -= 1;
    stdout.write("\x1b[35m[Subagent done]\x1b[0m\n");
  } else if (subagentDepth > 0) {
    stdout.write(`  \x1b[90m[sub] ${name}: ${output.slice(0, 100)}\x1b[0m\n`);
  }
});

function ensureRead(): void {
  if (buffered || inflight) return;
  inflight = iterator.next().then((result) => {
    inflight = null;
    buffered = result.done ? { done: true } : { done: false, line: result.value };
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

// The scheduler can fire while the prompt is open. A completed line stays
// buffered, so a cron turn cannot consume it as a permission answer.
async function waitForWake(): Promise<void> {
  ensureRead();
  const controller = new AbortController();
  const waits: Promise<void>[] = [(inflight ?? Promise.resolve()).then(() => undefined)];
  if (cronScheduler.hasQueued()) {
    const remaining = scheduleNotBefore - Date.now();
    waits.push(remaining > 0 ? delay(remaining) : Promise.resolve());
  } else {
    waits.push(cronScheduler.waitUntilQueued(controller.signal).then(() => undefined, () => undefined));
  }
  if (teamHost.hasLeadMail()) waits.push(Promise.resolve());
  else waits.push(teamHost.waitForLead(controller.signal).then(() => undefined, () => undefined));
  if (shouldResumeGoalForBackground() && hasRunningBackground()) {
    waits.push(waitForBackgroundIdle(controller.signal).then(() => undefined, () => undefined));
  }
  await Promise.race(waits);
  controller.abort();
}

type CliEvent =
  | { kind: "eof" }
  | { kind: "line"; line: string }
  | { kind: "scheduled" }
  | { kind: "team" }
  | { kind: "background" };

async function nextEvent(): Promise<CliEvent> {
  while (true) {
    if (buffered) {
      const next = buffered;
      buffered = null;
      promptShown = false;
      if (next.done) return { kind: "eof" };
      return { kind: "line", line: next.line };
    }
    if (cronScheduler.hasQueued() && Date.now() >= scheduleNotBefore) {
      if (promptShown) stdout.write("\n");
      promptShown = false;
      return { kind: "scheduled" };
    }
    if (teamHost.hasLeadMail()) {
      if (promptShown) stdout.write("\n");
      promptShown = false;
      return { kind: "team" };
    }
    if (shouldResumeGoalForBackground() && !hasRunningBackground() && hasBackgroundResult()) {
      if (promptShown) stdout.write("\n");
      promptShown = false;
      return { kind: "background" };
    }
    if (interactive && !promptShown) {
      stdout.write("> ");
      promptShown = true;
    }
    await waitForWake();
  }
}

async function reportTurn(
  run: (print: (text: string) => void) => Promise<boolean>,
): Promise<"empty" | "ok" | "failed"> {
  let lastText = "";
  let failed = false;
  let ran = false;
  try {
    ran = await run((text) => {
      if (text) lastText = text;
      stdout.write(text);
    });
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    if (lastText && !lastText.endsWith("\n")) stdout.write("\n");
    stderr.write(`Turn failed: ${message}\n`);
  }
  if (!ran && !failed) return "empty";
  if (!failed && lastText && !lastText.endsWith("\n")) stdout.write("\n");
  stdout.write("\nContext (Responses API input)\n");
  for (const item of transcript()) {
    const label = [item.type, "role" in item && item.role].filter(Boolean).join(" ");
    stdout.write(`[${label}]\n${JSON.stringify(item, null, 2)}\n`);
  }
  return failed ? "failed" : "ok";
}

let hadTeammates = false;

function noteTeammates(): void {
  if (teamHost.hasActive()) hadTeammates = true;
  else if (hadTeammates && !teamHost.hasLeadMail()) {
    stdout.write("[all teammates shut down]\n");
    hadTeammates = false;
  }
}

await teamHost.load();
await cronScheduler.load();
cronScheduler.start();
try {
  while (true) {
    const event = await nextEvent();
    if (event.kind === "eof") break;
    if (event.kind === "scheduled" || event.kind === "team" || event.kind === "background") {
      const run = event.kind === "scheduled"
        ? runScheduledTurn
        : event.kind === "team"
          ? runTeamTurn
          : runBackgroundResume;
      const status = await reportTurn((print) => run(print));
      if (status === "failed" && consumedScheduledWork()) scheduleNotBefore = Date.now() + 1000;
      noteTeammates();
      continue;
    }
    const command = event.line.trim();
    if (command === "/exit") break;
    if (!command) continue;
    await reportTurn(async (print) => {
      await runTurn(command, print);
      return true;
    });
    noteTeammates();
  }
} finally {
  cronScheduler.stop();
  await teamHost.stop();
}
