import {resolve} from 'node:path';
import {isWorkspaceTrusted, revokeWorkspace, trustWorkspace, workspaceHasProjectExtensions} from '../../config/trust.js';

/** `bitori trust [path] [--revoke]`：把当前/指定工作区加入(或移出)信任清单。 */
export async function runTrustCommand(options: {path?: string; revoke: boolean; json: boolean}): Promise<number> {
  const workspace = resolve(options.path ?? process.cwd());
  if (options.revoke) {
    const removed = await revokeWorkspace(workspace);
    if (options.json) process.stdout.write(`${JSON.stringify({workspace, revoked: removed})}\n`);
    else process.stdout.write(removed ? `已撤销信任：${workspace}\n` : `${workspace} 本来就不在信任清单\n`);
    return 0;
  }
  const already = isWorkspaceTrusted(workspace);
  await trustWorkspace(workspace);
  const hasExtensions = workspaceHasProjectExtensions(workspace);
  if (options.json) process.stdout.write(`${JSON.stringify({workspace, trusted: true, hasExtensions})}\n`);
  else {
    process.stdout.write(`${already ? '已在' : '已加入'}信任清单：${workspace}${hasExtensions ? '' : '\n提示：该工作区当前没有项目级 MCP/Hooks；信任记录为将来克隆的扩展兜底。'}\n`);
  }
  return 0;
}
