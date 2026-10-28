import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {parse as parseYaml, stringify as stringifyYaml} from 'yaml';
import {WorkspacePaths, WorkspacePathError} from './workspace-paths.js';
import type {ToolCall, ToolExecutionResult} from './types.js';

export type PermissionTier = 'strict' | 'default' | 'bypass';
export type PermissionDecision = 'allow' | 'ask' | 'deny';
export type PermissionSource = 'blacklist' | 'sandbox' | 'rule' | 'tier';
export interface PermissionRule {tool: string; pattern: string; decision: PermissionDecision; exact?: boolean}
export interface PermissionCheck {decision: PermissionDecision; source: PermissionSource; reason: string; rule?: PermissionRule}
export interface PermissionEngineOptions {workspaceRoot: string; userRulesPath?: string; projectRulesPath?: string; localRulesPath?: string}

const toolNames = new Set(['read_file', 'write_file', 'edit_file', 'find_files', 'search_text', 'run_command']);
// MCP 工具名由适配层生成；允许它们进入同一规则与人在回路系统。
function isToolName(value: string): boolean { return toolNames.has(value) || /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(value); }
const decisions = new Set(['allow', 'ask', 'deny']);
const tiers = new Set<PermissionTier>(['strict', 'default', 'bypass']);
interface LoadedFile {rules: PermissionRule[]; tier?: PermissionTier}

const blacklist: Array<{name: string; pattern: RegExp}> = [
  {name: '递归强制删除', pattern: /(?:\brm\s+-[a-z]*r[a-z]*f|\b(?:remove-item|ri|rmdir|del|erase)\b[^\r\n]*(?:-recurse|-force)|\bdel\s+\/[sqf])/i},
  {name: '格式化或磁盘分区', pattern: /\b(?:format(?:\.com)?|diskpart|clear-disk|initialize-disk|diskmgmt)\b/i},
  {name: '关机或重启', pattern: /\b(?:shutdown\s+\/(?:s|r|h)|stop-computer|restart-computer)\b/i},
  {name: '注册表高危写入', pattern: /\breg(?:\.exe)?\s+(?:add|delete|import)\b|\b(?:set|new)-itemproperty\b[^\r\n]*(?:hklm|hkey_local_machine)/i},
  {name: '禁用系统安全组件', pattern: /\b(?:set-mppreference\b[^\r\n]*disable|sc(?:\.exe)?\s+(?:stop|config)\s+[^\r\n]*(?:windefend|mpsvc)|net\s+stop\s+(?:windefend|mpsvc))\b/i},
  {name: '下载内容直接执行', pattern: /(?:invoke-webrequest|invoke-restmethod|\biwr\b|\birm\b|\bcurl\b|\bwget\b|bitsadmin)[^\r\n]*(?:\||iex|invoke-expression|start-process|powershell(?:\.exe)?)/i},
];

function isTier(value: unknown): value is PermissionTier { return typeof value === 'string' && tiers.has(value as PermissionTier); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function field(value: Record<string, unknown>, names: string[]): unknown { for (const name of names) if (name in value) return value[name]; return undefined; }
function parseRule(value: unknown, filePath: string, index: number): PermissionRule {
  if (!isRecord(value)) throw new Error(`${filePath}：第 ${index + 1} 条规则必须是对象`);
  let tool = field(value, ['tool', 'toolName', 'name']); let pattern = field(value, ['pattern', 'value']); const match = field(value, ['match', 'rule']); const decision = field(value, ['decision', 'action', 'result']);
  if (tool === undefined && typeof match === 'string') { const parsed = match.match(/^([A-Za-z0-9_-]+)\((.*)\)$/); if (parsed) { tool = parsed[1]; pattern = parsed[2]; } }
  else if (pattern === undefined && typeof match === 'string') pattern = match;
  if (typeof tool !== 'string' || !isToolName(tool)) throw new Error(`${filePath}：第 ${index + 1} 条规则的工具名无效`);
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error(`${filePath}：第 ${index + 1} 条规则的模式不能为空`);
  if (typeof decision !== 'string' || !decisions.has(decision)) throw new Error(`${filePath}：第 ${index + 1} 条规则的结果必须是 allow、ask 或 deny`);
  return {tool, pattern, decision: decision as PermissionDecision, ...(value.exact === true ? {exact: true} : {})};
}
function readRulesFile(filePath: string): LoadedFile {
  if (!existsSync(filePath)) return {rules: []};
  let parsed: unknown;
  try { parsed = parseYaml(readFileSync(filePath, 'utf8')); }
  catch (error) { throw new Error(`${filePath}：YAML 语法错误：${error instanceof Error ? error.message : String(error)}`, {cause: error}); }
  if (parsed === null || parsed === undefined) return {rules: []};
  if (Array.isArray(parsed)) return {rules: parsed.map((item, index) => parseRule(item, filePath, index))};
  if (!isRecord(parsed)) throw new Error(`${filePath}：根节点必须是对象或规则数组`);
  const allowedKeys = new Set(['rules', 'permissions', 'mode', 'tier', 'permission_tier', 'permission', 'permission_mode']); const unknownKey = Object.keys(parsed).find(key => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`${filePath}：不支持的配置字段 ${unknownKey}`);
  const rawRules = parsed.rules ?? parsed.permissions ?? []; if (!Array.isArray(rawRules)) throw new Error(`${filePath}：rules 必须是数组`);
  const rawTier = parsed.tier ?? parsed.mode ?? parsed.permission_tier ?? parsed.permission ?? parsed.permission_mode; if (rawTier !== undefined && !isTier(rawTier)) throw new Error(`${filePath}：权限档位必须是 strict、default 或 bypass`);
  return {rules: rawRules.map((item, index) => parseRule(item, filePath, index)), ...(rawTier === undefined ? {} : {tier: rawTier})};
}
function globRegex(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/'); let source = '^';
  for (let index = 0; index < normalized.length; index++) { const char = normalized[index]!; if (char === '*' && normalized[index + 1] === '*' && normalized[index + 2] === '/') { source += '(?:.*/)?'; index += 2; } else if (char === '*') { if (normalized[index + 1] === '*') { source += '.*'; index++; } else source += '[^/]*'; } else if (char === '?') source += '[^/]'; else source += /[\\^$+.()|{}[\]]/.test(char) ? `\\${char}` : char; }
  return new RegExp(`${source}$`, 'i');
}
function matches(pattern: string, value: string): boolean { return pattern.includes('*') || pattern.includes('?') ? globRegex(pattern).test(value) : pattern.toLowerCase() === value.toLowerCase(); }
function callValue(call: ToolCall): string | null {
  if (call.name === 'run_command') return typeof call.arguments.command === 'string' ? call.arguments.command : null;
  if (call.name === 'read_file' || call.name === 'write_file' || call.name === 'edit_file') return typeof call.arguments.path === 'string' ? call.arguments.path.replaceAll('\\', '/') : null;
  if (call.name === 'find_files') return typeof call.arguments.pattern === 'string' ? call.arguments.pattern.replaceAll('\\', '/') : null;
  if (call.name === 'search_text') return typeof call.arguments.filePattern === 'string' ? call.arguments.filePattern.replaceAll('\\', '/') : '';
  if (call.name.startsWith('mcp__')) return JSON.stringify(call.arguments);
  return null;
}

/** 五层权限判定核心：危险命令、真实路径、规则、档位与人在回路。 */
export class PermissionEngine {
  readonly workspaceRoot: string; readonly userRulesPath: string; readonly projectRulesPath: string; readonly localRulesPath: string;
  #tier: PermissionTier; #rules: PermissionRule[]; #localRules: PermissionRule[]; readonly #sessionRules: PermissionRule[] = []; #paths: WorkspacePaths | null = null;
  constructor(options: PermissionEngineOptions) {
    this.workspaceRoot = options.workspaceRoot; const userDirectory = join(homedir(), '.bitori');
    this.userRulesPath = options.userRulesPath ?? join(userDirectory, 'permissions.yaml'); this.projectRulesPath = options.projectRulesPath ?? join(options.workspaceRoot, '.bitori', 'permissions.yaml'); this.localRulesPath = options.localRulesPath ?? join(options.workspaceRoot, '.bitori', 'permissions.local.yaml');
    const user = readRulesFile(this.userRulesPath); const project = readRulesFile(this.projectRulesPath); const local = readRulesFile(this.localRulesPath);
    this.#rules = [...user.rules, ...project.rules, ...local.rules]; this.#localRules = [...local.rules]; this.#tier = local.tier ?? 'default';
  }
  get tier(): PermissionTier { return this.#tier; }
  allRules(): readonly PermissionRule[] { return [...this.#rules]; }
  async evaluate(call: ToolCall): Promise<PermissionCheck> {
    if (call.effect === 'command') { const command = typeof call.arguments.command === 'string' ? call.arguments.command : ''; const blocked = blacklist.find(item => item.pattern.test(command)); if (blocked) return {decision: 'deny', source: 'blacklist', reason: `命令命中危险黑名单：${blocked.name}`}; }
    try { await this.#assertSandbox(call); }
    catch (error) { return {decision: 'deny', source: 'sandbox', reason: error instanceof Error ? error.message : '路径未通过工作区沙箱'}; }
    const value = callValue(call) ?? ''; const matching = this.#rules.filter(rule => rule.tool === call.name && (rule.exact ? rule.pattern === value : matches(rule.pattern.replaceAll('\\', '/'), value)));
    const strongest = matching.find(rule => rule.decision === 'deny') ?? matching.find(rule => rule.decision === 'ask') ?? matching.find(rule => rule.decision === 'allow');
    if (strongest) {
      if (strongest.decision === 'deny') return {decision: 'deny', source: 'rule', reason: `命中 deny 规则：${strongest.tool}(${strongest.pattern})`, rule: strongest};
      if (strongest.decision === 'ask') return this.#tier === 'bypass' ? {decision: 'allow', source: 'tier', reason: '放行档自动放行 ask 规则', rule: strongest} : {decision: 'ask', source: 'rule', reason: `命中 ask 规则：${strongest.tool}(${strongest.pattern})`, rule: strongest};
      if (this.#tier === 'strict') return {decision: 'ask', source: 'tier', reason: '严格档不采纳 allow 规则'};
      return {decision: 'allow', source: 'rule', reason: `命中 allow 规则：${strongest.tool}(${strongest.pattern})`, rule: strongest};
    }
    if (this.#tier === 'strict') return {decision: 'ask', source: 'tier', reason: '严格档要求所有工具调用确认'};
    if (this.#tier === 'bypass') return {decision: 'allow', source: 'tier', reason: '放行档自动放行'};
    return {decision: call.effect === 'read' ? 'allow' : 'ask', source: 'tier', reason: call.effect === 'read' ? '默认档自动放行只读工具' : '默认档要求副作用工具确认'};
  }
  denialResult(check: PermissionCheck): ToolExecutionResult { return {status: 'denied', error: {code: 'permission_denied', message: `工具调用被拒绝（${check.source}）：${check.reason}`, retryable: false, details: {source: check.source, reason: check.reason}}}; }
  addSessionAllow(call: ToolCall): void { const rule = this.#exactRule(call); this.#sessionRules.push(rule); this.#rules.push(rule); }
  addPermanentAllow(call: ToolCall): void { const rule = this.#exactRule(call); this.#localRules.push(rule); this.#rules.push(rule); this.#writeLocal(); }
  setTier(tier: PermissionTier): void { this.#tier = tier; this.#writeLocal(); }
  #exactRule(call: ToolCall): PermissionRule { return {tool: call.name, pattern: callValue(call) ?? '', decision: 'allow', exact: true}; }
  async #assertSandbox(call: ToolCall): Promise<void> {
    if (call.effect === 'command' || call.name.startsWith('mcp__')) return; const paths = this.#paths ??= await WorkspacePaths.create(this.workspaceRoot);
    try { if (call.name === 'read_file' || call.name === 'edit_file') await paths.existingFile(callValue(call) ?? ''); else if (call.name === 'write_file') await paths.newFile(callValue(call) ?? ''); else { const pattern = callValue(call) ?? ''; paths.validateRelative(pattern || '.'); } }
    catch (error) { if (error instanceof WorkspacePathError && error.code === 'path_outside_workspace') throw error; if (!(error instanceof WorkspacePathError)) throw new WorkspacePathError('path_outside_workspace', '路径无法通过工作区沙箱校验'); }
  }
  #writeLocal(): void { mkdirSync(dirname(this.localRulesPath), {recursive: true}); writeFileSync(this.localRulesPath, stringifyYaml({mode: this.#tier, rules: this.#localRules}), 'utf8'); }
}

export {toolNames};
