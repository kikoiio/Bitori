import {z} from 'zod';
import type {TeamManager} from '../../teams/team.js';
import {FileMailbox} from '../../teams/file-mailbox.js';
import type {JsonObject, Tool, ToolExecutionResult} from '../types.js';

const createSchema = z.object({name: z.string().trim().min(1), description: z.string().default('')}).strict();
const sendSchema = z.object({team: z.string(), from: z.string(), to: z.string(), text: z.string().min(1)}).strict();
const receiveSchema = z.object({team: z.string(), member: z.string()}).strict();

/** 团队工具走持久化文件邮箱，任何成员实例都能用游标恢复读取。 */
export class TeamTools implements Tool<Record<string, never>> {
  readonly name = 'team';
  readonly description = '团队协作工具：创建团队、发送消息、读取成员邮箱';
  readonly effect = 'write' as const;
  readonly inputSchema: JsonObject = {
    type: 'object',
    properties: {
      action: {type: 'string', enum: ['create', 'send', 'receive']},
      name: {type: 'string'},
      description: {type: 'string'},
      team: {type: 'string'},
      from: {type: 'string'},
      to: {type: 'string'},
      member: {type: 'string'},
      text: {type: 'string'},
    },
  };

  constructor(private readonly teams: TeamManager) {}

  parseArguments(input: unknown): Record<string, never> {
    const raw = input as {action?: string};
    if (raw.action === 'create') return createSchema.parse(input) as unknown as Record<string, never>;
    if (raw.action === 'send') return sendSchema.parse(input) as unknown as Record<string, never>;
    if (raw.action === 'receive') return receiveSchema.parse(input) as unknown as Record<string, never>;
    throw new Error('action 必须是 create、send 或 receive');
  }

  async execute(args: JsonObject): Promise<ToolExecutionResult> {
    try {
      if (args.action === 'create') {
        const description = args.description;
        const team = this.teams.create(String(args.name), typeof description === 'string' ? description : '');
        return {status: 'success', output: {team}};
      }
      if (args.action === 'send') {
        const mailbox = new FileMailbox(this.teams.directory(String(args.team)), String(args.to));
        await mailbox.send(String(args.from), String(args.text));
        return {status: 'success', output: {sent: true}};
      }
      if (args.action === 'receive') {
        const mailbox = new FileMailbox(this.teams.directory(String(args.team)), String(args.member));
        return {status: 'success', output: {messages: await mailbox.receive()}};
      }
      return {status: 'error', error: {code: 'invalid_arguments', message: 'action 必须是 create、send 或 receive', retryable: false}};
    } catch (error) {
      return {status: 'error', error: {code: 'internal_error', message: error instanceof Error ? error.message : String(error), retryable: false}};
    }
  }
}
