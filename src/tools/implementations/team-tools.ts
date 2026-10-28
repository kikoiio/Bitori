import {z} from 'zod';
import type {TeamManager} from '../../teams/team.js';
import {FileMailbox} from '../../teams/file-mailbox.js';
import type {JsonObject, Tool, ToolExecutionResult} from '../types.js';

const member = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const schema = z.discriminatedUnion('action', [
  z.strictObject({action: z.literal('create'), name: z.string().trim().min(1), description: z.string().default('')}),
  z.strictObject({action: z.literal('send'), team: z.string().trim().min(1), from: member, to: member, text: z.string().min(1)}),
  z.strictObject({action: z.literal('receive'), team: z.string().trim().min(1), member}),
]);

/** 团队工具走持久化文件邮箱，任何成员实例都能用游标恢复读取。 */
export class TeamTools implements Tool<z.infer<typeof schema>> {
  readonly name = 'team';
  readonly description = '团队协作工具：创建团队、发送消息、读取成员邮箱';
  readonly effect = 'write' as const;
  readonly inputSchema: JsonObject = z.toJSONSchema(schema, {io: 'input'});

  constructor(private readonly teams: TeamManager) {}

  parseArguments(input: unknown): z.infer<typeof schema> { return schema.parse(input); }

  async execute(args: z.infer<typeof schema>): Promise<ToolExecutionResult> {
    try {
      if (args.action === 'create') {
        const team = this.teams.create(args.name, args.description);
        return {status: 'success', output: {team}};
      }
      if (args.action === 'send') {
        if (!this.teams.get(args.team)) throw new Error(`团队不存在：${args.team}`);
        const mailbox = new FileMailbox(this.teams.directory(args.team), args.to);
        await mailbox.send(args.from, args.text);
        return {status: 'success', output: {sent: true}};
      }
      if (args.action === 'receive') {
        if (!this.teams.get(args.team)) throw new Error(`团队不存在：${args.team}`);
        const mailbox = new FileMailbox(this.teams.directory(args.team), args.member);
        return {status: 'success', output: {messages: await mailbox.receive()}};
      }
      return {status: 'error', error: {code: 'invalid_arguments', message: 'action 必须是 create、send 或 receive', retryable: false}};
    } catch (error) {
      return {status: 'error', error: {code: 'internal_error', message: error instanceof Error ? error.message : String(error), retryable: false}};
    }
  }
}
