import type {JsonObject} from '../tools/types.js';
import type {McpClient} from './client.js';

/** [s06] 本步固定使用仍包含 initialize 握手的 2025-06-18 协议版本。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export type JsonRpcId = string | number;
export interface JsonRpcRequest {jsonrpc: '2.0'; id: JsonRpcId; method: string; params?: JsonObject}
export interface JsonRpcNotification {jsonrpc: '2.0'; method: string; params?: JsonObject}
export interface JsonRpcSuccess {jsonrpc: '2.0'; id: JsonRpcId; result: unknown}
export interface JsonRpcFailure {jsonrpc: '2.0'; id: JsonRpcId | null; error: {code: number; message: string; data?: unknown}}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export interface McpTransport {
  start(onMessage: (message: unknown) => void, onClose: (error?: Error) => void): Promise<void>;
  send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void>;
  setProtocolVersion?(version: string): void;
  close(): Promise<void>;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

export interface McpToolResult extends JsonObject {
  content: unknown[];
  isError?: boolean;
  structuredContent?: JsonObject;
}

export interface McpConnectedServer {
  name: string;
  client: McpClient;
  tools: McpToolDefinition[];
}

export class McpProtocolError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = 'McpProtocolError';
  }
}
