import {Box, Text, useWindowSize} from 'ink';
import {useState} from 'react';
import type {ChatController} from '../chat/agent-controller.js';
import type {ProfileSummary} from '../config/types.js';
import {useChatController} from './hooks/use-chat-controller.js';
import {ChatScreen} from './screens/chat-screen.js';
import {ProfileSelectScreen} from './screens/profile-select-screen.js';
import {TerminalTooSmallScreen} from './screens/terminal-too-small-screen.js';

export interface AppProps {
  profiles: ProfileSummary[];
  initialController: ChatController | null;
  createController: (profileName: string) => Promise<ChatController>;
  onController: (controller: ChatController) => void;
  onExit: () => void;
}

/** [s01] controller 已存在时，用 hook 将其外部状态接入 React 组件树。 */
function ControllerApp({controller, height, onExit}: {controller: ChatController; height: number; onExit: () => void}) {
  const state = useChatController(controller);
  return <ChatScreen state={state} controller={controller} height={height} onExit={onExit} />;
}

export function App({profiles, initialController, createController, onController, onExit}: AppProps) {
  // [s01] Ink hook 会在终端缩放时提供新尺寸，从而触发重新渲染。
  const {columns: width, rows: height} = useWindowSize();
  const [controller, setController] = useState(initialController);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // [s01] 顶层按优先级选择唯一页面：尺寸提示 > 聊天 > 加载 > profile 选择。
  if (width < 60 || height < 16) return <TerminalTooSmallScreen width={width} height={height} onExit={onExit} />;
  if (controller !== null) return <ControllerApp controller={controller} height={height} onExit={onExit} />;
  if (loading) return <Box justifyContent="center" alignItems="center" width={width} height={height}><Text>正在加载会话…</Text></Box>;
  return <>
    {error ? <Text color="red">{error}</Text> : null}
    <ProfileSelectScreen profiles={profiles} onExit={onExit} onSelect={profile => {
      setLoading(true);
      // [s01] 事件回调本身不能 await，因此用 void 明确启动异步链，并在 catch 中把失败显示到界面。
      void createController(profile.name).then(value => {
        onController(value);
        setController(value);
      }).catch(reason => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      });
    }} />
  </>;
}
