import {McpProtocolError} from './types.js';
import type {McpClient} from './client.js';
import type {McpToolDefinition} from './types.js';
import type {JsonObject, Tool, ToolExecutionResult} from '../tools/types.js';
import {truncateUtf8} from '../tools/limits.js';

function objectArguments(input: unknown): JsonObject {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('MCP 工具参数必须是 JSON 对象');
  return input as JsonObject;
}

function boundedOutput(result: {content: unknown[]; structuredContent?: JsonObject}, maximumBytes: number): {output: JsonObject; truncation: ReturnType<typeof truncateUtf8>['truncation'] | null} {
  const output: JsonObject = {content: result.content, ...(result.structuredContent ? {structuredContent: result.structuredContent} : {})};
  const serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, 'utf8') <= maximumBytes) return {output, truncation: null};
  const originalBytes = Buffer.byteLength(serialized, 'utf8');
  let low = 0; let high = maximumBytes;
  let limited = truncateUtf8(serialized, 0);
  let bounded: JsonObject = {};
  while (low <= high) {
    const candidate = truncateUtf8(serialized, Math.floor((low + high) / 2));
    const wrapped: JsonObject = {content: [{type: 'text', text: candidate.text}], truncated: true, originalBytes};
    if (Buffer.byteLength(JSON.stringify(wrapped), 'utf8') <= maximumBytes) {
      bounded = wrapped; limited = candidate; low = Math.floor((low + high) / 2) + 1;
    } else high = Math.floor((low + high) / 2) - 1;
  }
  return {output: bounded, truncation: limited.truncation};
}

function remoteError(result: {content: unknown[]; structuredContent?: JsonObject}, maximumBytes: number): ToolExecutionResult {
  const bounded = boundedOutput(result, maximumBytes);
  return {status: 'error', error: {code: 'mcp_error', message: '远端 MCP 工具返回错误', retryable: false, details: bounded.output}, ...(bounded.truncation ? {truncation: bounded.truncation} : {})};
}

/** 外部工具统一视为有副作用，继续经过人在回路与串行屏障。 */
export class McpToolAdapter implements Tool {
  readonly effect = 'command' as const;
  readonly strict = false;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;

  constructor(readonly serverName: string, readonly remote: McpToolDefinition, readonly client: McpClient, publicName: string) {
    this.name = publicName;
    this.description = `[MCP:${serverName}] ${remote.description ?? remote.name}`;
    this.inputSchema = remote.inputSchema;
  }

  parseArguments(input: unknown): JsonObject { return objectArguments(input); }

  async execute(args: JsonObject, context: Parameters<Tool['execute']>[1]): Promise<ToolExecutionResult> {
    try {
      const result = await this.client.callTool(this.remote.name, args, context.signal);
      if (result.isError) return remoteError(result, context.limits.maxResultBytes);
      const bounded = boundedOutput(result, context.limits.maxResultBytes);
      return {status: 'success', output: bounded.output, ...(bounded.truncation ? {truncation: bounded.truncation} : {})};
    } catch (error) {
      if (context.signal.aborted || error instanceof DOMException && error.name === 'AbortError') {
        return {status: 'interrupted', error: {code: 'interrupted', message: 'MCP 工具调用已取消', retryable: false}};
      }
      const protocol = error instanceof McpProtocolError;
      return {status: 'error', error: {code: 'mcp_error', message: error instanceof Error ? error.message : 'MCP 工具调用失败', retryable: protocol, ...(protocol && error.data !== undefined ? {details: {rpcCode: error.code ?? 0, data: error.data}} : {})}};
    }
  }
}

/** Provider 工具名只保留通用安全字符，并限制为常见的 64 字符上限。 */
export function mcpPublicToolName(serverName: string, toolName: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  const prefix = `mcp__${clean(serverName)}__`;
  return `${prefix}${clean(toolName)}`.slice(0, 64);
}
