import type {PermissionTier} from '../tools/permission-engine.js';

export type ChatCommand = 'plan' | 'do' | 'compact' | {type: 'permission'; tier: PermissionTier} | {type: 'unknown'; text: string} | null;

/** [s03] 仅精确的小写命令会改变会话模式。 */
export function parseChatCommand(text: string): ChatCommand {
  const normalized = text.trim();
  if (normalized === '/plan') return 'plan';
  if (normalized === '/do') return 'do';
  if (normalized === '/compact' || normalized === '/c') return 'compact';
  const permission = normalized.match(/^\/(?:permission|permissions|mode)\s+(strict|default|bypass|放行|严格|默认)$/);
  if (permission) {
    const tier = permission[1] === 'strict' || permission[1] === '严格' ? 'strict' : permission[1] === 'bypass' || permission[1] === '放行' ? 'bypass' : 'default';
    return {type: 'permission', tier};
  }
  return normalized.startsWith('/') ? {type: 'unknown', text: normalized} : null;
}
