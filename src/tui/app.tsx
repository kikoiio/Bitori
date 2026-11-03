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
  createController: (profileName: string, modelOverride?: string) => Promise<ChatController>;
  listModels?: (profileName: string) => Promise<{models: Array<{id: string; displayName?: string; enabled: boolean}>; note?: string; error?: string}>;
  onController: (controller: ChatController) => void;
  onExit: () => void;
  workspace?: string;
}

/** controller 已存在时，用 hook 将其外部状态接入 React 组件树。 */
function ControllerApp({controller, height, onExit, profiles, onSwitchProfile, listModels, workspace}: {controller: ChatController; height: number; onExit: () => void; profiles: ProfileSummary[]; onSwitchProfile: (name: string, modelOverride?: string) => Promise<void>; listModels?: AppProps['listModels']; workspace?: string | undefined}) {
  const state = useChatController(controller);
  return <ChatScreen state={state} controller={controller} height={height} onExit={onExit} profiles={profiles} onSwitchProfile={onSwitchProfile} {...(listModels === undefined ? {} : {listModels})} workspace={workspace} />;
}

export function App({profiles, initialController, createController, listModels, onController, onExit, workspace}: AppProps) {
  // Ink hook 会在终端缩放时提供新尺寸，从而触发重新渲染。
  const {columns: width, rows: height} = useWindowSize();
  const [controller, setController] = useState(initialController);
  const [instance, setInstance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchProfile = async (name: string, modelOverride?: string): Promise<void> => {
    const next = await createController(name, modelOverride);
    onController(next);
    setController(next);
    setInstance(value => value + 1);
  };
  // 顶层按优先级选择唯一页面：尺寸提示 > 聊天 > 加载 > profile 选择。
  if (width < 60 || height < 16) return <TerminalTooSmallScreen width={width} height={height} onExit={onExit} />;
  if (controller !== null) return <ControllerApp key={instance} controller={controller} height={height} onExit={onExit} profiles={profiles} onSwitchProfile={switchProfile} {...(listModels === undefined ? {} : {listModels})} workspace={workspace} />;
  if (loading) return <Box justifyContent="center" alignItems="center" width={width} height={height}><Text>正在加载会话…</Text></Box>;
  return <>
    {error ? <Text color="red">{error}</Text> : null}
    <ProfileSelectScreen profiles={profiles} onExit={onExit} onSelect={profile => {
      setLoading(true);
      // 控制器创建失败时在界面显示错误。
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
