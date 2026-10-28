import {useSyncExternalStore} from 'react';
import type {ChatController} from '../../chat/agent-controller.js';
import type {AppState} from '../../chat/state.js';

/**
 * 用 React 官方的外部状态 Hook 订阅 ChatController。
 * 第 1 个回调负责订阅，第 2 个读取客户端快照，第 3 个是服务端渲染时的快照（这里相同）。
 */
export function useChatController(controller: ChatController): AppState {
  return useSyncExternalStore(
    listener => controller.subscribe(listener),
    () => controller.getState(),
    () => controller.getState(),
  );
}
