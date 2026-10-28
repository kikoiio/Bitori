import {z} from 'zod';
import {buildWorktreeNotice, createAgentWorktree, hasWorktreeChanges, removeAgentWorktree, worktreeRelativePath} from '../../worktree/worktree.js';
import type {Tool, ToolContext, ToolExecutionResult} from '../types.js';

const enterSchema = z.object({slug: z.string().trim().min(1)}).strict();
const exitSchema = z.object({slug: z.string().trim().min(1), force: z.boolean().default(false)}).strict();

interface WorktreeSession {slug: string; path: string; branch: string; gitRoot: string; headCommit: string}

/** Worktree 状态由工具实例持有，不改变其他工具的工作区。 */
export class EnterWorktreeTool implements Tool<{slug: string}> {
  readonly name = 'enter_worktree';
  readonly description = '创建或恢复 Git Worktree；文件和命令工具仍从原工作区执行';
  readonly effect = 'write' as const;
  readonly inputSchema = z.toJSONSchema(enterSchema, {io: 'input'});
  readonly #sessions = new Map<string, WorktreeSession>();

  parseArguments(input: unknown) { return enterSchema.parse(input); }
  execute(args: {slug: string}, context: ToolContext): Promise<ToolExecutionResult> { return Promise.resolve(this.#runEnter(args, context)); }

  #runEnter(args: {slug: string}, context: ToolContext): ToolExecutionResult {
    try {
      const worktree = createAgentWorktree(args.slug, context.workspaceRoot);
      this.#sessions.set(args.slug, {slug: args.slug, ...worktree});
      return {status: 'success', output: {slug: args.slug, path: worktree.path, branch: worktree.branch, relativePath: worktreeRelativePath(context.workspaceRoot, worktree.path), notice: buildWorktreeNotice(context.workspaceRoot, worktree.path)}};
    } catch (error) {
      return {status: 'error', error: {code: 'internal_error', message: error instanceof Error ? error.message : String(error), retryable: false}};
    }
  }

  session(slug: string): WorktreeSession | null { return this.#sessions.get(slug) ?? null; }
  forget(slug: string): void { this.#sessions.delete(slug); }
}

/** 默认保护文件及独有提交，移除工作树时保留分支。 */
export class ExitWorktreeTool implements Tool<{slug: string; force: boolean}> {
  readonly name = 'exit_worktree';
  readonly description = '移除 Worktree 并保留分支；存在未提交文件或独有提交时需 force=true';
  readonly effect = 'write' as const;
  readonly inputSchema = z.toJSONSchema(exitSchema, {io: 'input'});
  readonly strict = false;

  constructor(private readonly enter: EnterWorktreeTool) {}

  parseArguments(input: unknown) { return exitSchema.parse(input); }
  execute(args: {slug: string; force: boolean}): Promise<ToolExecutionResult> { return Promise.resolve(this.#runExit(args)); }

  #runExit(args: {slug: string; force: boolean}): ToolExecutionResult {
    const session = this.enter.session(args.slug);
    if (!session) return {status: 'error', error: {code: 'path_not_found', message: `尚未进入 Worktree：${args.slug}`, retryable: false}};
    const changed = hasWorktreeChanges(session.path, session.headCommit, session.gitRoot);
    if (changed && !args.force) return {status: 'error', error: {code: 'permission_denied', message: 'Worktree 存在未提交文件或独有提交，或状态无法确认；确认移除工作树时使用 force=true（分支仍会保留）', retryable: false}};
    try {
      removeAgentWorktree(session.path, session.branch, session.gitRoot, args.force);
      this.enter.forget(args.slug);
      return {status: 'success', output: {slug: args.slug, removed: true}};
    } catch (error) {
      return {status: 'error', error: {code: 'internal_error', message: error instanceof Error ? error.message : String(error), retryable: false}};
    }
  }
}
