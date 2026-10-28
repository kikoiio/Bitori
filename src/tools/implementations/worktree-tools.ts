import {z} from 'zod';
import {buildWorktreeNotice, createAgentWorktree, hasWorktreeChanges, removeAgentWorktree} from '../../worktree/worktree.js';
import type {JsonObject, Tool, ToolContext, ToolExecutionResult} from '../types.js';

const enterSchema = z.object({slug: z.string().trim().min(1)}).strict();
const exitSchema = z.object({slug: z.string().trim().min(1), force: z.boolean().default(false)}).strict();

interface WorktreeSession {slug: string; path: string; branch: string; gitRoot: string}

/** Worktree 状态由工具实例持有；后续命令工具接入时以该状态为执行根。 */
export class EnterWorktreeTool implements Tool<{slug: string}> {
  readonly name = 'enter_worktree';
  readonly description = '创建或恢复一个隔离 Git Worktree，后续文件与命令操作应显式使用返回的绝对路径';
  readonly effect = 'write' as const;
  readonly inputSchema: JsonObject = {type: 'object', properties: {slug: {type: 'string'}}, required: ['slug'], additionalProperties: false};
  readonly #sessions = new Map<string, WorktreeSession>();

  parseArguments(input: unknown) { return enterSchema.parse(input); }
  execute(args: {slug: string}, context: ToolContext): Promise<ToolExecutionResult> { return Promise.resolve(this.#runEnter(args, context)); }

  #runEnter(args: {slug: string}, context: ToolContext): ToolExecutionResult {
    try {
      const worktree = createAgentWorktree(args.slug, context.workspaceRoot);
      this.#sessions.set(args.slug, {slug: args.slug, ...worktree});
      return {status: 'success', output: {slug: args.slug, path: worktree.path, branch: worktree.branch, notice: buildWorktreeNotice(context.workspaceRoot, worktree.path)}};
    } catch (error) {
      return {status: 'error', error: {code: 'internal_error', message: error instanceof Error ? error.message : String(error), retryable: false}};
    }
  }

  session(slug: string): WorktreeSession | null { return this.#sessions.get(slug) ?? null; }
}

/** 退出前默认保护未提交变更，force 才允许清理。 */
export class ExitWorktreeTool implements Tool<{slug: string; force: boolean}> {
  readonly name = 'exit_worktree';
  readonly description = '退出并清理 Worktree；存在未提交变更时默认拒绝，force=true 才会强制清理';
  readonly effect = 'write' as const;
  readonly inputSchema: JsonObject = {type: 'object', properties: {slug: {type: 'string'}, force: {type: 'boolean', default: false}}, required: ['slug'], additionalProperties: false};

  constructor(private readonly enter: EnterWorktreeTool) {}

  parseArguments(input: unknown) { return exitSchema.parse(input); }
  execute(args: {slug: string; force: boolean}): Promise<ToolExecutionResult> { return Promise.resolve(this.#runExit(args)); }

  #runExit(args: {slug: string; force: boolean}): ToolExecutionResult {
    const session = this.enter.session(args.slug);
    if (!session) return {status: 'error', error: {code: 'path_not_found', message: `尚未进入 Worktree：${args.slug}`, retryable: false}};
    const changed = hasWorktreeChanges(session.path, null);
    if (changed && !args.force) return {status: 'error', error: {code: 'permission_denied', message: 'Worktree 存在未提交变更；确认丢弃时使用 force=true', retryable: false}};
    try {
      removeAgentWorktree(session.path, session.branch, session.gitRoot);
      return {status: 'success', output: {slug: args.slug, removed: true}};
    } catch (error) {
      return {status: 'error', error: {code: 'internal_error', message: error instanceof Error ? error.message : String(error), retryable: false}};
    }
  }
}
