import type OpenAI from "openai";

// Host configuration authorizes a call. Server annotations never do.
const hostPolicy = new Map<string, McpPolicy>([
  ["docs/search", "allow"],
  ["docs/get_version", "allow"],
  ["deploy/status", "allow"],
  ["deploy/trigger", "confirm"],
]);

const disallowedName = /[^a-zA-Z0-9_-]/g;
const maxToolNameLength = 64;

export type McpPolicy = "allow" | "confirm";

type JsonType = "string" | "number" | "integer" | "boolean";

interface McpToolDraft {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

type McpHandler = (args: Record<string, unknown>) => string;

interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
  invoke: McpHandler;
}

interface BoundTool {
  prefixed: string;
  origin: string;
  policy: McpPolicy;
  definition: OpenAI.Responses.FunctionTool;
  invoke: McpHandler;
}

interface MockSpec {
  name: string;
  drafts: McpToolDraft[];
  handlers: Record<string, McpHandler>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonType(value: unknown): value is JsonType {
  return value === "string" || value === "number" || value === "integer" || value === "boolean";
}

export function normalizeMcpName(name: string): string {
  const normalized = name.replace(disallowedName, "_");
  if (normalized === "") throw new Error("MCP names cannot normalize to an empty string");
  return normalized;
}

function policyFor(server: string, tool: string): McpPolicy {
  return hostPolicy.get(`${server}/${tool}`) ?? "confirm";
}

function named(keys: readonly string[], run: (values: Record<string, string>) => string): McpHandler {
  return (args) => {
    const extra = Object.keys(args).filter((key) => !keys.includes(key));
    const unexpected = extra[0];
    if (unexpected !== undefined) {
      throw new TypeError(`got an unexpected keyword argument '${unexpected}'`);
    }
    const values: Record<string, string> = {};
    for (const key of keys) {
      if (!Object.hasOwn(args, key)) throw new TypeError(`missing a required argument: '${key}'`);
      const value = args[key];
      if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
      values[key] = value;
    }
    return run(values);
  };
}

function objectSchema(properties: Record<string, { type: JsonType }>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required };
}

function docsSpec(): MockSpec {
  return {
    name: "docs",
    drafts: [
      {
        name: "search",
        description: "Search the documentation.",
        inputSchema: objectSchema({ query: { type: "string" } }, ["query"]),
        annotations: { readOnlyHint: true },
      },
      {
        name: "get_version",
        description: "Get the documentation API version.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
    handlers: {
      search: named(["query"], (values) => `[docs] Found 3 results for '${values.query}'`),
      get_version: named([], () => "[docs] API v2.1.0"),
    },
  };
}

function deploySpec(): MockSpec {
  return {
    name: "deploy",
    drafts: [
      {
        name: "trigger",
        description: "Trigger a deployment.",
        inputSchema: objectSchema({ service: { type: "string" } }, ["service"]),
        annotations: { destructiveHint: true },
      },
      {
        name: "status",
        description: "Check deployment status.",
        inputSchema: objectSchema({ service: { type: "string" } }, ["service"]),
        annotations: { readOnlyHint: true },
      },
    ],
    handlers: {
      trigger: named(["service"], (values) => `[deploy] Triggered: ${values.service}`),
      status: named(["service"], (values) => `[deploy] ${values.service}: running (v1.4.2)`),
    },
  };
}

function mockSpec(name: string): MockSpec | undefined {
  if (name === "docs") return docsSpec();
  if (name === "deploy") return deploySpec();
  return undefined;
}

function invalidSchema(origin: string): Error {
  return new Error(`Invalid input schema for ${origin}`);
}

function parseProperty(value: unknown, origin: string): { type: JsonType; description?: string } {
  if (!isPlainObject(value) || !isJsonType(value.type)) throw invalidSchema(origin);
  for (const key of Object.keys(value)) {
    if (key !== "type" && key !== "description") throw invalidSchema(origin);
  }
  if (value.description === undefined) return { type: value.type };
  if (typeof value.description !== "string") throw invalidSchema(origin);
  return { type: value.type, description: value.description };
}

function strictParameters(schema: unknown, origin: string): { [key: string]: unknown } {
  if (!isPlainObject(schema)) throw invalidSchema(origin);
  if (schema.type !== undefined && schema.type !== "object") throw invalidSchema(origin);
  const rawProperties = schema.properties === undefined ? {} : schema.properties;
  if (!isPlainObject(rawProperties)) throw invalidSchema(origin);
  const rawRequired = schema.required === undefined ? [] : schema.required;
  if (!Array.isArray(rawRequired)) throw invalidSchema(origin);
  const requiredNames: string[] = [];
  for (const item of rawRequired) {
    if (typeof item !== "string") throw invalidSchema(origin);
    requiredNames.push(item);
  }
  const properties: { [key: string]: { [key: string]: unknown } } = {};
  const required: string[] = [];
  for (const [key, raw] of Object.entries(rawProperties)) {
    const property = parseProperty(raw, origin);
    const encoded: { [key: string]: unknown } = {
      type: requiredNames.includes(key) ? property.type : [property.type, "null"],
    };
    if (property.description !== undefined) encoded.description = property.description;
    properties[key] = encoded;
    required.push(key);
  }
  for (const key of requiredNames) {
    if (!Object.hasOwn(properties, key)) throw invalidSchema(origin);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function compileServer(serverName: string, drafts: readonly McpToolDraft[], handlers: Readonly<Record<string, McpHandler>>): McpToolSpec[] {
  for (const draft of drafts) {
    if (!isPlainObject(draft) || typeof draft.name !== "string" || draft.name === "") {
      throw new Error("Every MCP tool needs a non-empty name");
    }
    if (draft.description !== undefined && typeof draft.description !== "string") {
      throw new Error(`Invalid MCP tool definition for '${draft.name}'`);
    }
    if (draft.annotations !== undefined && !isPlainObject(draft.annotations)) {
      throw new Error(`Invalid MCP tool definition for '${draft.name}'`);
    }
  }
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (seen.has(draft.name)) throw new Error(`Duplicate MCP tool name on server '${serverName}'`);
    seen.add(draft.name);
  }
  const missing = drafts.filter((draft) => handlers[draft.name] === undefined).map((draft) => draft.name);
  if (missing.length > 0) throw new Error(`Missing MCP handlers: ${missing.join(", ")}`);
  return drafts.map((draft) => {
    const invoke = handlers[draft.name];
    if (invoke === undefined) throw new Error(`Missing MCP handlers: ${draft.name}`);
    return {
      name: draft.name,
      description: draft.description ?? "",
      inputSchema: draft.inputSchema ?? {},
      invoke,
    };
  });
}

export class McpRegistry {
  #servers = new Map<string, string>();
  #bindings = new Map<string, BoundTool>();

  connect(name: string, reserved: ReadonlySet<string> = new Set()): string {
    if (this.#servers.has(name)) return `MCP server '${name}' already connected`;
    const spec = mockSpec(name);
    if (!spec) return `Unknown server '${name}'. Available: docs, deploy`;
    try {
      return this.addServer(spec.name, spec.drafts, spec.handlers, reserved);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  addServer(
    name: string,
    drafts: readonly McpToolDraft[],
    handlers: Readonly<Record<string, McpHandler>>,
    reserved: ReadonlySet<string> = new Set(),
  ): string {
    if (this.#servers.has(name)) return `MCP server '${name}' already connected`;
    const tools = compileServer(name, drafts, handlers);
    const origins = new Map<string, string>();
    for (const builtin of reserved) origins.set(builtin, `built-in tool '${builtin}'`);
    for (const binding of this.#bindings.values()) origins.set(binding.prefixed, binding.origin);
    const safeServer = normalizeMcpName(name);
    const bindings: BoundTool[] = [];
    for (const tool of tools) {
      const prefixed = `mcp__${safeServer}__${normalizeMcpName(tool.name)}`;
      if (prefixed.length > maxToolNameLength) {
        throw new Error(`MCP tool name is longer than 64 characters: ${prefixed}`);
      }
      const origin = `MCP tool '${name}'/'${tool.name}'`;
      const previous = origins.get(prefixed);
      if (previous !== undefined) {
        throw new Error(`MCP tool name collision after normalization: '${prefixed}' maps both ${previous} and ${origin}`);
      }
      const parameters = strictParameters(tool.inputSchema, origin);
      origins.set(prefixed, origin);
      bindings.push({
        prefixed,
        origin,
        policy: policyFor(name, tool.name),
        invoke: tool.invoke,
        definition: {
          type: "function",
          name: prefixed,
          description: tool.description,
          parameters,
          strict: true,
        },
      });
    }
    for (const binding of bindings) this.#bindings.set(binding.prefixed, binding);
    this.#servers.set(name, name);
    const discovered = tools.map((tool) => tool.name).join(", ");
    process.stderr.write(`  [mcp] connected: ${name} -> ${discovered}\n`);
    return `Connected to MCP server '${name}'. Discovered ${tools.length} tools: ${discovered}`;
  }

  toolDefinitions(reserved: ReadonlySet<string>): OpenAI.Responses.FunctionTool[] {
    const definitions: OpenAI.Responses.FunctionTool[] = [];
    for (const binding of this.#bindings.values()) {
      if (reserved.has(binding.prefixed)) {
        throw new Error(
          `MCP tool name collision after normalization: '${binding.prefixed}' maps both built-in tool '${binding.prefixed}' and ${binding.origin}`,
        );
      }
      definitions.push(binding.definition);
    }
    return definitions;
  }

  handlers(): Record<string, (input: unknown) => Promise<string>> {
    const handlers: Record<string, (input: unknown) => Promise<string>> = {};
    for (const binding of this.#bindings.values()) {
      const prefixed = binding.prefixed;
      handlers[prefixed] = async (input) => this.call(prefixed, input);
    }
    return handlers;
  }

  call(prefixed: string, args: unknown): string {
    const binding = this.#bindings.get(prefixed);
    if (!binding) return `MCP error: unknown tool '${prefixed}'`;
    if (!isPlainObject(args)) return "MCP error: TypeError: arguments must be an object";
    try {
      return String(binding.invoke(args));
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      return `MCP error: ${name}: ${message}`;
    }
  }

  policy(prefixed: string): McpPolicy {
    return this.#bindings.get(prefixed)?.policy ?? "confirm";
  }

  connectedLine(): string {
    if (this.#servers.size === 0) return "";
    return `Connected MCP servers: ${[...this.#servers.keys()].join(", ")}`;
  }

  appendNotice(body: string): string {
    const line = this.connectedLine();
    return line === "" ? body : `${body}\n\n${line}`;
  }
}

export const mcpRegistry = new McpRegistry();
