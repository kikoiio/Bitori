import {platform, release} from 'node:os';
import type {ProviderProfile} from '../config/types.js';
import type {PromptSection} from './builder.js';

/** [s04] 会话激活时采集并冻结的环境信息；同一会话内不再变动。 */
export interface EnvironmentInfo {
  workspaceRoot: string;
  os: string;
  nodeVersion: string;
  /** [s04] 本地日期，YYYY-MM-DD。 */
  date: string;
  profileName: string;
  model: string;
}

/** [s04] 从进程与 profile 采集环境信息六字段。 */
export function collectEnvironment(profile: ProviderProfile, workspaceRoot: string): EnvironmentInfo {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return {workspaceRoot, os: `${platform()} ${release()}`, nodeVersion: process.version, date, profileName: profile.name, model: profile.model};
}

/** [s04] 渲染环境信息模块文本（优先级 80，排在七个固定模块之后）。 */
export function environmentSection(env: EnvironmentInfo): PromptSection {
  return {
    id: 'environment',
    priority: 80,
    text: [
      '# 环境信息',
      `- 工作区根目录: ${env.workspaceRoot}`,
      `- 操作系统: ${env.os}`,
      `- Node.js: ${env.nodeVersion}`,
      `- 日期: ${env.date}`,
      `- Profile: ${env.profileName}`,
      `- 模型: ${env.model}`,
    ].join('\n'),
  };
}
