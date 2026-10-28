import {useSyncExternalStore} from 'react';
import type {ChatController} from '../../chat/agent-controller.js';
import type {AppState} from '../../chat/state.js';

/**
 * 用 React 官方的外部状态 Hook 订阅 ChatController。
 */
export function useChatController(controller: ChatController): AppState {
  return useSyncExternalStore(
    listener => controller.subscribe(listener),
    () => controller.getState(),
    () => controller.getState(),
  );
}
