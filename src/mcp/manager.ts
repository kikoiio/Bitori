import type {McpServerConfig} from '../config/types.js';
import type {ToolRegistry} from '../tools/registry.js';
import {errorMessage} from '../shared/errors.js';
import {getLogger} from '../shared/logger.js';
import {McpClient} from './client.js';
import {StreamableHttpMcpTransport} from './http-transport.js';
import {StdioMcpTransport} from './stdio-transport.js';
import {McpToolAdapter, mcpPublicToolName} from './tool-adapter.js';
import type {McpTransport} from './types.js';

const logger = getLogger('mcp');

export interface McpServerFailure {name: string; error: Error}
export interface McpInitializationResult {connected: string[]; failed: McpServerFailure[]; registeredTools: string[]}

class McpServerInitializationError extends Error {
  constructor(readonly serverName: string, readonly original: Error) {
    super(original.message, {cause: original});
  }
}

export type McpTransportFactory = (name: string, config: McpServerConfig) => McpTransport;

/** 每个 Server 独立建立并缓存一条 Client；失败只淘汰自身，不影响其他连接。 */
export class McpManager {
  readonly #clients = new Map<string, McpClient>();
  readonly #initializing = new Set<McpClient>();
  #initializePromise: Promise<McpInitializationResult> | null = null;
  #closePromise: Promise<void> | null = null;
  #closing = false;

  constructor(
    readonly registry: ToolRegistry,
    readonly servers: Record<string, McpServerConfig>,
    readonly workspaceRoot: string,
    readonly transportFactory: McpTransportFactory = (_name, config) => config.transport === 'stdio'
      ? new StdioMcpTransport({command: config.command, args: config.args, env: config.env, cwd: workspaceRoot})
      : new StreamableHttpMcpTransport(config.url, config.headers),
  ) {}

  initialize(): Promise<McpInitializationResult> {
    if (this.#closing) return Promise.reject(new Error('MCP Manager 已关闭'));
    this.#initializePromise ??= this.#initializeAll();
    return this.#initializePromise;
  }

  get(name: string): McpClient | undefined { return this.#clients.get(name); }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise ??= (async () => {
      const clients = new Set([...this.#clients.values(), ...this.#initializing]);
      await Promise.allSettled([...clients].map(client => client.close()));
      if (this.#initializePromise) await this.#initializePromise.catch(() => undefined);
      this.#clients.clear();
    })();
    return this.#closePromise;
  }

  async #initializeAll(): Promise<McpInitializationResult> {
    const settled = await Promise.allSettled(Object.entries(this.servers).map(async ([name, config]) => {
      const transport = this.transportFactory(name, config);
      const client = new McpClient(transport);
      this.#initializing.add(client);
      try {
        await client.initialize();
        const tools = await client.listTools();
        return {name, client, tools};
      } catch (error) {
        // 初始化失败后的关闭也降级记录，避免传输资源泄漏不可见。
        await client.close().catch((closeError: unknown) => { logger.warn('MCP Server 初始化失败后关闭连接异常', {server: name, error: errorMessage(closeError)}); });
        this.#initializing.delete(client);
        throw new McpServerInitializationError(name, error instanceof Error ? error : new Error(String(error)));
      }
    }));

    const connected: string[] = [];
    const registeredTools: string[] = [];
    const failed: McpServerFailure[] = [];
    for (const item of settled) {
      if (item.status === 'rejected') {
        const reason: unknown = item.reason;
        failed.push(reason instanceof McpServerInitializationError
          ? {name: reason.serverName, error: reason.original}
          : {name: '(unknown)', error: reason instanceof Error ? reason : new Error('MCP Server 初始化失败')});
        continue;
      }
      const {name, client, tools} = item.value;
      if (this.#closing) {
        this.#initializing.delete(client);
        failed.push({name, error: new Error('MCP Manager 已关闭')});
        continue;
      }
      const names = tools.map(tool => mcpPublicToolName(name, tool.name));
      const duplicate = names.find((publicName, index) => names.indexOf(publicName) !== index || this.registry.get(publicName) !== undefined);
      if (duplicate) {
        failed.push({name, error: new Error(`MCP 工具名称冲突：${duplicate}`)});
        // 冲突淘汰路径的关闭失败同样可见。
        await client.close().catch((closeError: unknown) => { logger.warn('MCP Server 工具名冲突后关闭连接异常', {server: name, error: errorMessage(closeError)}); });
        this.#initializing.delete(client);
        continue;
      }
      for (const [index, tool] of tools.entries()) {
        const publicName = names[index]!;
        this.registry.register(new McpToolAdapter(name, tool, client, publicName));
        registeredTools.push(publicName);
      }
      this.#clients.set(name, client);
      this.#initializing.delete(client);
      connected.push(name);
    }
    return {connected, failed, registeredTools};
  }
}
