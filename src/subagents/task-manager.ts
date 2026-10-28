export type AgentTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentTask {
  id: string;
  name: string;
  prompt: string;
  status: AgentTaskStatus;
  output: string;
  createdAt: number;
  finishedAt: number | null;
}

/** 后台任务完成时写入通知队列，由主循环 drain 成 task-notification。 */
export class TaskManager {
  readonly #tasks = new Map<string, AgentTask>();
  #notifications: string[] = [];
  #sequence = 0;

  launch(name: string, prompt: string, operation: (signal: AbortSignal) => Promise<string>, options: {timeoutMs?: number} = {}): AgentTask {
    const id = `task-${++this.#sequence}`;
    const task: AgentTask = {id, name, prompt, status: 'running', output: '', createdAt: Date.now(), finishedAt: null};
    this.#tasks.set(id, task);
    const controller = new AbortController();
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), options.timeoutMs);
    void operation(controller.signal)
      .then(output => { task.status = 'completed'; task.output = output; this.#notifications.push(`<task-notification task="${id}" status="completed">\n${output}\n</task-notification>`); })
      .catch(error => { task.status = controller.signal.aborted ? 'cancelled' : 'failed'; task.output = error instanceof Error ? error.message : String(error); this.#notifications.push(`<task-notification task="${id}" status="${task.status}">\n${task.output}\n</task-notification>`); })
      .finally(() => { task.finishedAt = Date.now(); if (timer !== undefined) clearTimeout(timer); });
    return task;
  }

  get(id: string): AgentTask | null { return this.#tasks.get(id) ?? null; }
  list(): readonly AgentTask[] { return [...this.#tasks.values()]; }
  drainNotifications(): string[] {
    const messages = this.#notifications;
    this.#notifications = [];
    return messages;
  }
}
