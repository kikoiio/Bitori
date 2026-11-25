import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { project } from "./config.ts";
import { isAgentName } from "./names.ts";

export type MailMessage = {
  from: string;
  to: string;
  content: string;
  type: string;
  ts: number;
  metadata: Record<string, unknown>;
};

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMessage(line: string): MailMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (typeof data.from !== "string" || typeof data.to !== "string") return null;
  if (typeof data.content !== "string" || typeof data.type !== "string") return null;
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const ts = typeof data.ts === "number" ? data.ts : Date.now();
  return { from: data.from, to: data.to, content: data.content, type: data.type, ts, metadata };
}

// File mailboxes with destructive reads. `has` stays in memory so the CLI can poll it.
export class Mailbox {
  readonly directory: string;
  #pending = new Set<string>();
  #waiters = new Map<string, Array<() => void>>();
  #tail: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
  }

  #exclusive<T>(action: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(action, action);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  #path(agent: string): string {
    if (!isAgentName(agent)) throw new Error(`Invalid mailbox recipient: ${JSON.stringify(agent)}`);
    const path = resolve(this.directory, `${agent}.jsonl`);
    const rel = relative(this.directory, path);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) {
      throw new Error(`Mailbox path escapes directory: ${JSON.stringify(agent)}`);
    }
    return path;
  }

  #notify(agent: string): void {
    const waiters = this.#waiters.get(agent)?.splice(0) ?? [];
    for (const wake of waiters) wake();
  }

  has(agent: string): boolean {
    return this.#pending.has(agent);
  }

  async load(): Promise<void> {
    await this.#exclusive(async () => {
      let names: string[];
      try {
        names = await readdir(this.directory);
      } catch (error) {
        if (isEnoent(error)) return;
        throw error;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const agent = name.slice(0, -".jsonl".length);
        if (!isAgentName(agent)) continue;
        try {
          if ((await stat(this.#path(agent))).size > 0) this.#pending.add(agent);
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
      }
    });
  }

  async send(
    fromAgent: string,
    toAgent: string,
    content: string,
    type = "message",
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const message: MailMessage = {
      from: fromAgent,
      to: toAgent,
      content,
      type,
      ts: Date.now(),
      metadata,
    };
    await this.#exclusive(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(this.#path(toAgent), `${JSON.stringify(message)}\n`, "utf8");
      this.#pending.add(toAgent);
      this.#notify(toAgent);
    });
    process.stderr.write(`  [bus] ${fromAgent} -> ${toAgent}: (${type}) ${content.slice(0, 50)}\n`);
  }

  async read(agent: string): Promise<MailMessage[]> {
    return this.#exclusive(async () => {
      const path = this.#path(agent);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (isEnoent(error)) {
          this.#pending.delete(agent);
          return [];
        }
        throw error;
      }
      await unlink(path).catch((error: unknown) => {
        if (!isEnoent(error)) throw error;
      });
      this.#pending.delete(agent);
      const messages: MailMessage[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const message = parseMessage(line);
        if (message) messages.push(message);
        else process.stderr.write(`  [bus] skipped a corrupt line for ${agent}\n`);
      }
      return messages;
    });
  }

  waitFor(agent: string, signal: AbortSignal): Promise<void> {
    if (this.has(agent)) return Promise.resolve();
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      let wake: () => void = () => undefined;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        const waiting = this.#waiters.get(agent);
        if (waiting) {
          const remaining = waiting.filter((waiter) => waiter !== wake);
          if (remaining.length === 0) this.#waiters.delete(agent);
          else this.#waiters.set(agent, remaining);
        }
        if (ok) resolvePromise();
        else reject(new Error("mailbox wait aborted"));
      };
      const onAbort = () => finish(false);
      wake = () => finish(true);
      const waiting = this.#waiters.get(agent) ?? [];
      waiting.push(wake);
      this.#waiters.set(agent, waiting);
      signal.addEventListener("abort", onAbort, { once: true });
      if (this.has(agent)) finish(true);
      else if (signal.aborted) finish(false);
    });
  }
}

export const mailbox = new Mailbox(resolve(project, ".mailboxes"));
