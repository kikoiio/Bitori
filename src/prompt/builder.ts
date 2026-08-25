import type {EnvironmentInfo} from './environment.js';
import {environmentSection} from './environment.js';
import {FIXED_SECTIONS} from './sections.js';

/** [s04] 一段可独立形成缓存边界的系统提示文本。 */
export interface PromptBlock { text: string; cacheable: boolean }

/** [s04] 一个按优先级参与拼装的提示模块；可选模块也经此注册。 */
export interface PromptSection { id: string; priority: number; text: string }

/** [s04] 构建结果：blocks 供 provider 映射缓存边界；text 供测试与快照断言。 */
export interface SystemPrompt { blocks: PromptBlock[]; text: string }

/** [s04] 模块优先级；间距预留插位，后续新增模块不动现有编号。 */
export const SECTION_PRIORITY = {
  identity: 10,
  systemConstraints: 20,
  taskModes: 30,
  actionExecution: 40,
  toolUsage: 50,
  toneStyle: 60,
  textOutput: 70,
  environment: 80,
  customInstructions: 90,
  skills: 100,
  longTermMemory: 110,
} as const;

/** [s04]
 * 按优先级拼装系统提示：七个固定模块合成首个可缓存稳定块；
 * 环境信息与可选模块各自成块且不参与缓存，保证可缓存前缀在会话内逐字节稳定。
 */
export function buildSystemPrompt(env: EnvironmentInfo, optionalSections: readonly PromptSection[] = []): SystemPrompt {
  const stableText = FIXED_SECTIONS.map(section => section.text).join('\n\n');
  const extras = [...optionalSections]
    .filter(section => section.text.trim().length > 0)
    .sort((a, b) => a.priority - b.priority);
  const blocks: PromptBlock[] = [
    {text: stableText, cacheable: true},
    {text: environmentSection(env).text, cacheable: false},
    ...extras.map(section => ({text: section.text, cacheable: false})),
  ];
  return {blocks, text: blocks.map(block => block.text).join('\n\n')};
}
