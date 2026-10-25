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

/** [s06] 每个 Server 独立建立并缓存一条 Client；失败只淘汰自身，不影响其他连接。 */
export class McpManager {
  readonly #clients = new Map<string, McpClient>();
  #initializePromise: Promise<McpInitializationResult> | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(
    readonly registry: ToolRegistry,
    readonly servers: Record<string, McpServerConfig>,
    readonly workspaceRoot: string,
    readonly transportFactory: McpTransportFactory = (_name, config) => config.transport === 'stdio'
      ? new StdioMcpTransport({command: config.command, args: config.args, env: config.env, cwd: workspaceRoot})
      : new StreamableHttpMcpTransport(config.url, config.headers),
  ) {}

  initialize(): Promise<McpInitializationResult> {
    this.#initializePromise ??= this.#initializeAll();
    return this.#initializePromise;
  }

  get(name: string): McpClient | undefined { return this.#clients.get(name); }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      await Promise.allSettled([...this.#clients.values()].map(client => client.close()));
      this.#clients.clear();
    })();
    return this.#closePromise;
  }

  async #initializeAll(): Promise<McpInitializationResult> {
    const settled = await Promise.allSettled(Object.entries(this.servers).map(async ([name, config]) => {
      const transport = this.transportFactory(name, config);
      const client = new McpClient(transport);
      try {
        await client.initialize();
        const tools = await client.listTools();
        return {name, client, tools};
      } catch (error) {
        // [s15] 初始化失败后的关闭也降级记录，避免传输资源泄漏不可见。
        await client.close().catch((closeError: unknown) => { logger.warn('MCP Server 初始化失败后关闭连接异常', {server: name, error: errorMessage(closeError)}); });
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
      const names = tools.map(tool => mcpPublicToolName(name, tool.name));
      const duplicate = names.find((publicName, index) => names.indexOf(publicName) !== index || this.registry.get(publicName) !== undefined);
      if (duplicate) {
        failed.push({name, error: new Error(`MCP 工具名称冲突：${duplicate}`)});
        // [s15] 冲突淘汰路径的关闭失败同样可见。
        await client.close().catch((closeError: unknown) => { logger.warn('MCP Server 工具名冲突后关闭连接异常', {server: name, error: errorMessage(closeError)}); });
        continue;
      }
      for (const [index, tool] of tools.entries()) {
        const publicName = names[index]!;
        this.registry.register(new McpToolAdapter(name, tool, client, publicName));
        registeredTools.push(publicName);
      }
      this.#clients.set(name, client);
      connected.push(name);
    }
    return {connected, failed, registeredTools};
  }
}
