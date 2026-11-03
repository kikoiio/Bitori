import {statSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {configPaths, loadConfig} from '../../config/loader.js';
import {redactSecrets} from '../../config/secrets.js';
import type {AppConfig, ProviderProfile} from '../../config/types.js';
import {probeProfile} from '../../diagnostics/connection.js';
import {isWorkspaceTrusted, workspaceHasProjectExtensions} from '../../config/trust.js';

type CheckStatus = 'ok' | 'warn' | 'fail';
export interface DoctorCheck {name: string; status: CheckStatus; detail: string}

/** 收集全部诊断项;runDoctorCommand 负责输出,测试直接断言这里。 */
export async function buildDoctorChecks(options: {profile?: string; json: boolean}, workspace: string, fetchImpl?: typeof fetch): Promise<{checks: DoctorCheck[]; profiles: ProviderProfile[]}> {
  const checks: DoctorCheck[] = [];
  const paths = configPaths();
  checks.push({name: '配置文件', status: existsSync(paths.config) ? 'ok' : 'fail', detail: existsSync(paths.config) ? paths.config : `缺少 ${paths.config};首次运行 bitori 会生成模板`});
  checks.push({name: '密钥文件', status: existsSync(paths.environment) ? 'ok' : 'fail', detail: existsSync(paths.environment) ? paths.environment : `缺少 ${paths.environment}`});

  let config: AppConfig | null = null;
  try {
    config = loadConfig(undefined, workspace);
    const summary = config.profiles.map(profile => `${profile.name}·${profile.protocol}`).join(' ');
    checks.push({name: '配置解析', status: 'ok', detail: `${config.profiles.length} 个 profile：${summary}`});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({name: '配置解析', status: 'fail', detail: message});
  }

  const profiles = config === null ? [] : config.profiles.filter(p => options.profile === undefined || p.name === options.profile);
  if (config !== null && options.profile !== undefined && profiles.length === 0) {
    checks.push({name: 'profile 选择', status: 'fail', detail: `找不到 profile：${options.profile}(可用:${config.profiles.map(p => p.name).join(', ') || '无'})`});
  }
  for (const profile of profiles) {
    // 协议是写死的还是推断出来的，必须让用户看见；猜错了要能一眼发现。
    checks.push({name: `协议 ${profile.name}`, status: 'ok', detail: `${profile.protocol} · ${profile.protocolReason ?? 'config.yaml 显式指定'}`});
    if (profile.apiKey.length === 0) {
      checks.push({name: `凭据 ${profile.name}`, status: 'fail', detail: `请在 .env 中填写 ${profile.apiKeyVariable ?? 'API key'}`});
      continue;
    }
    checks.push({name: `凭据 ${profile.name}`, status: 'ok', detail: `来源 ${profile.apiKeyVariable ?? 'config'}(值不显示)`});
  }
  checks.push({name: '工作区', status: existsSync(workspace) ? 'ok' : 'fail', detail: workspace});
  const hasExtensions = workspaceHasProjectExtensions(workspace);
  const trusted = isWorkspaceTrusted(workspace);
  checks.push({name: '工作区信任', status: hasExtensions && !trusted ? 'warn' : 'ok', detail: hasExtensions ? (trusted ? '项目级 MCP/Hooks 已信任并将加载' : '未信任：项目级 MCP/Hooks 已默认拒载；确认后运行 bitori trust 启用') : '未发现项目级 MCP/Hooks'});
  const databasePath = join(workspace, '.bitori', 'bitori.db');
  if (existsSync(databasePath)) {
    const size = statSync(databasePath).size;
    checks.push({name: '本地数据库', status: 'ok', detail: `${databasePath}(${Math.round(size / 1024)} KB)`});
  } else {
    checks.push({name: '本地数据库', status: 'warn', detail: `${databasePath} 尚未创建;首次会话启动后生成`});
  }

  const probes = await Promise.all(profiles
    .filter(profile => profile.apiKey.length > 0)
    .map(profile => probeProfile(profile, fetchImpl ?? fetch)));
  for (const probe of probes) {
    if (!probe.ok) {
      checks.push({name: `连接 ${probe.profileName}`, status: 'fail', detail: `${probe.error?.code ?? 'unknown'}(HTTP ${probe.error?.statusCode ?? '-'}):${probe.error?.message ?? ''} → ${probe.guidance ?? ''}`});
    } else {
      const count = probe.models === undefined ? '' : ` · ${probe.models.filter(model => model.enabled).length} 个可用模型`;
      const modelState = probe.modelAvailable === false ? ` · ⚠ 模型 “${probe.model}” 不在列表:${probe.guidance ?? ''}` : ` · 模型 “${probe.model}” ✓`;
      checks.push({
        name: `连接 ${probe.profileName}`,
        status: probe.modelAvailable === false ? 'warn' : 'ok',
        detail: `${probe.latencyMs}ms${count}${probe.note !== undefined && probe.modelAvailable !== false ? ` · ${probe.note}` : modelState}`,
      });
      if (probe.models !== undefined) {
        for (const model of probe.models.slice(0, 12)) {
          checks.push({name: `模型 ${probe.profileName}/${model.id}`, status: model.enabled ? 'ok' : 'warn', detail: model.displayName ?? (model.enabled ? '可用' : '未启用')});
        }
      }
    }
  }

  const allProfiles = config === null ? [] : config.profiles;
  for (const check of checks) check.detail = redactSecrets(check.detail, allProfiles);
  return {checks, profiles: allProfiles};
}

/** `bitori doctor`：输出诊断;任何检查项/日志/终端都不含密钥值(build 阶段已脱敏)。 */
export async function runDoctorCommand(options: {profile?: string; json: boolean}, workspace: string, fetchImpl?: typeof fetch): Promise<number> {
  const {checks} = await buildDoctorChecks(options, workspace, fetchImpl);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({at: new Date().toISOString(), workspace, checks}, null, 2)}\n`);
  } else {
    const lines = checks.map(check => `[${check.status.toUpperCase().padEnd(4)}] ${check.name.padEnd(24)} ${check.detail}`);
    process.stdout.write(`bitori doctor · node ${process.versions.node} · ${new Date().toISOString()}\n${lines.join('\n')}\n`);
  }
  return checks.some(check => check.status === 'fail') ? 1 : 0;
}
