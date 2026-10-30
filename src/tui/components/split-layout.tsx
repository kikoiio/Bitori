import {Box, Text, useInput} from 'ink';
import {useState} from 'react';
import type {AppState} from '../../chat/state.js';
import {MessageList} from './message-list.js';
import {ToolCallList} from './tool-call-list.js';
import {PromptInput} from './prompt-input.js';
import {StatusBar} from './status-bar.js';
import {ErrorBanner} from './error-banner.js';
import {ToolApprovalPanel} from './tool-approval-panel.js';
import {DebugPanel} from './debug-panel.js';

interface SplitLayoutProps {
  state: AppState;
  height: number;
  onExit: () => void;
  controller: any;
}

export function SplitLayout({state, height, onExit, controller}: SplitLayoutProps) {
  const [leftPanelWidth, setLeftPanelWidth] = useState(40); // 左侧面板宽度（字符数）
  const [focus, setFocus] = useState<'left' | 'right'>('right');
  const [draft, setDraft] = useState('');
  const [offset, setOffset] = useState(0);
  
  const debugHeight = state.debugOpen ? Math.max(8, Math.floor(height / 3)) : 0;
  const visibleError = state.visibleError;
  const messageHeight = Math.max(5, height - 7 - (visibleError === null ? 0 : 3) - debugHeight);
  
  // 键盘交互
  useInput((input, key) => {
    if (key.escape) {
      onExit();
      return;
    }
    
    // 调整面板宽度
    if (focus === 'left') {
      if (key.leftArrow && leftPanelWidth > 20) {
        setLeftPanelWidth(leftPanelWidth - 2);
      } else if (key.rightArrow && leftPanelWidth < 80) {
        setLeftPanelWidth(leftPanelWidth + 2);
      }
    }
    
    // 切换焦点
    if (key.tab) {
      setFocus(focus === 'left' ? 'right' : 'left');
    }
    
    // 其他快捷键传递给右侧聊天面板
    if (focus === 'right') {
      if (key.pageUp) {
        setOffset(value => Math.min(state.messages.length - 1, value + 1));
      } else if (key.pageDown) {
        setOffset(value => Math.max(0, value - 1));
      }
    }
  });

  return (
    <Box flexDirection="row" height={height}>
      {/* 左侧面板：文件树 + 代码预览 */}
      <Box width={leftPanelWidth} flexDirection="column" borderStyle="single" borderColor="gray">
        <Box paddingX={1}>
          <Text bold>📁 文件浏览器</Text>
        </Box>
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text dimColor>文件树功能开发中...</Text>
          <Text dimColor>（←/→ 调整宽度，Tab 切换焦点）</Text>
        </Box>
      </Box>
      
      {/* 右侧面板：对话 + 工具调用 */}
      <Box flexGrow={1} flexDirection="column">
        <StatusBar state={state} />
        <ErrorBanner message={visibleError} />
        <MessageList 
          messages={state.messages} 
          height={messageHeight} 
          offset={offset}
          selectedMessageId={state.selectedMessageId} 
          expandedThinkingIds={state.expandedThinkingIds} 
          toolCalls={state.toolCalls} 
        />
        {state.approvalPrompt ? <ToolApprovalPanel prompt={state.approvalPrompt} /> : null}
        {state.debugOpen ? <DebugPanel state={state} controller={controller} height={debugHeight} /> : null}
        <PromptInput value={draft} focused={focus === 'right'} disabled={state.requestStatus !== 'idle'} />
      </Box>
    </Box>
  );
}
