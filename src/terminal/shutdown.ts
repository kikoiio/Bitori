import type {ChatController} from '../chat/controller.js';
import type {TerminalSession} from './session.js';

export type ShutdownReason = 'user' | 'fatal_error';

/** [s01]
 * 生成一个幂等的关闭函数：无论 Ctrl+C、finally 或未处理异常调用多少次，
 * 都会共享同一个 Promise，只关闭一次控制器和终端。
 */
export function createShutdownOnce(
  getController: () => ChatController | null,
  getTerminal: () => TerminalSession | null,
): (reason: ShutdownReason) => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return (reason: ShutdownReason) => {
    // [s01] 当前两个关闭原因执行相同流程；保留参数是为了以后可按原因扩展日志或退出码。
    void reason;
    shutdownPromise ??= (async () => {
      await getController()?.shutdown();
      getTerminal()?.unmount();
    })();
    return shutdownPromise;
  };
}
