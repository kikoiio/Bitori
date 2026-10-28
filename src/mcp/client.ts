import {JsonRpcPeer} from './json-rpc.js';
import {MCP_PROTOCOL_VERSION, McpProtocolError} from './types.js';
import type {JsonObject} from '../tools/types.js';
import type {McpToolDefinition, McpToolResult, McpTransport} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asTool(value: unknown): McpToolDefinition {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.trim().length === 0 || !isRecord(value.inputSchema)) {
    throw new McpProtocolError('tools/list 返回了非法工具定义');
  }
  return {name: value.name, ...(typeof value.description === 'string' ? {description: value.description} : {}), inputSchema: value.inputSchema};
}

/** 单 Server 会话严格执行 initialize → initialized → tools/list → tools/call。 */
export class McpClient {
  readonly #peer: JsonRpcPeer;
  #initialized = false;

  constructor(transport: McpTransport, timeoutMs = 30_000) {
    this.#peer = new JsonRpcPeer(transport, timeoutMs);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#peer.start();
    const raw = await this.#peer.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {name: 'Bitori', version: '0.1.0'},
    });
    if (!isRecord(raw) || typeof raw.protocolVersion !== 'string' || !isRecord(raw.capabilities)) {
      throw new McpProtocolError('initialize 返回值无效');
    }
    if (raw.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new McpProtocolError(`MCP 协议版本不兼容：Server 返回 ${raw.protocolVersion}`);
    }
    this.#peer.transport.setProtocolVersion?.(raw.protocolVersion);
    await this.#peer.notify('notifications/initialized');
    this.#initialized = true;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    if (!this.#initialized) throw new McpProtocolError('MCP Client 尚未初始化');
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const raw = await this.#peer.request('tools/list', cursor === undefined ? {} : {cursor}, signal);
      if (!isRecord(raw) || !Array.isArray(raw.tools)) throw new McpProtocolError('tools/list 返回值无效');
      tools.push(...raw.tools.map(asTool));
      cursor = typeof raw.nextCursor === 'string' && raw.nextCursor.length > 0 ? raw.nextCursor : undefined;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<McpToolResult> {
    if (!this.#initialized) throw new McpProtocolError('MCP Client 尚未初始化');
    const raw = await this.#peer.request('tools/call', {name, arguments: args}, signal);
    if (!isRecord(raw) || !Array.isArray(raw.content)) throw new McpProtocolError('tools/call 返回值无效');
    return {
      content: raw.content,
      ...(raw.isError === true ? {isError: true} : {}),
      ...(isRecord(raw.structuredContent) ? {structuredContent: raw.structuredContent} : {}),
    };
  }

  close(): Promise<void> { return this.#peer.close(); }
}
