import type {ChatController} from '../chat/agent-controller.js';
import type {TerminalSession} from './session.js';

export type ShutdownReason = 'user' | 'fatal_error';

export function createShutdownOnce(
  getController: () => ChatController | null,
  getTerminal: () => TerminalSession | null,
  closeResources?: () => Promise<void>,
): (reason: ShutdownReason) => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    shutdownPromise ??= (async () => {
      const failures: unknown[] = [];
      try { await getController()?.shutdown(); } catch (error) { failures.push(error); }
      try { await closeResources?.(); } catch (error) { failures.push(error); }
      try { getTerminal()?.unmount(); } catch (error) { failures.push(error); }
      if (failures.length) throw failures[0];
    })();
    return shutdownPromise;
  };
}
