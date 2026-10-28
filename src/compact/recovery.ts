import type {ToolDefinition} from '../tools/types.js';

export const MAX_RECOVERY_FILES = 5;
const MAX_FILE_SNAPSHOT_TOKENS = 5_000;
const CHARS_PER_TOKEN = 3.5;

export interface FileReadRecord {path: string; content: string; at: number}

/** 压缩后无法从摘要还原的近期事实；目前覆盖文件。 */
export class RecoveryState {
  readonly #files: FileReadRecord[] = [];

  recordFileRead(path: string, content: string, at = Date.now()): void {
    const existing = this.#files.findIndex(file => file.path === path);
    if (existing >= 0) this.#files.splice(existing, 1);
    this.#files.push({path, content, at});
  }

  snapshotFiles(): readonly FileReadRecord[] {
    return [...this.#files].sort((a, b) => b.at - a.at).slice(0, MAX_RECOVERY_FILES).map(file => ({...file}));
  }

  buildRecoveryAttachment(tools: readonly ToolDefinition[]): string {
    const files = this.snapshotFiles().map(file => {
      const limit = Math.floor(MAX_FILE_SNAPSHOT_TOKENS * CHARS_PER_TOKEN);
      const content = Buffer.from(file.content, 'utf8').subarray(0, limit).toString('utf8');
      return `- ${file.path}${Buffer.byteLength(content, 'utf8') < Buffer.byteLength(file.content, 'utf8') ? ' (content truncated)' : ''}\n${content}`;
    });
    return [
      '## 最近读过的文件',
      ...(files.length > 0 ? files : ['- 无']),
      '',
      '## 当前可用工具',
      ...tools.map(tool => `- ${tool.name}: ${tool.description}`),
      '',
      '## 边界提示',
      '以上内容是压缩后的恢复信息。需要文件、工具输出或代码细节时请重新读取原文，不要凭摘要或头部预览猜测。',
    ].join('\n');
  }
}
