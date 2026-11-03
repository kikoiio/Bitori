import {Box, Text, useInput, useWindowSize} from 'ink';
import {useRef, useState} from 'react';
import type {ProfileSummary} from '../../config/types.js';
import {theme} from '../theme.js';

export interface ProfileSelectScreenProps {
  profiles: ProfileSummary[];
  onSelect: (profile: ProfileSummary) => void;
  onExit: () => void;
}

export function ProfileSelectScreen({profiles, onSelect, onExit}: ProfileSelectScreenProps) {
  const {columns, rows} = useWindowSize();
  const [selected, setSelected] = useState(0);
  // ref 会即时更新且不等待 React 下一次渲染，快速连续按键时可避免读到旧 selected。
  const selectedRef = useRef(0);
  useInput((input, key) => {
    if (input === 'c' && key.ctrl) onExit();
    else if (key.upArrow) {
      selectedRef.current = Math.max(0, selectedRef.current - 1);
      setSelected(selectedRef.current);
    } else if (key.downArrow) {
      selectedRef.current = Math.min(profiles.length - 1, selectedRef.current + 1);
      setSelected(selectedRef.current);
    } else if (key.return) {
      const profile = profiles[selectedRef.current];
      if (profile !== undefined) onSelect(profile);
    }
  });
  return <Box flexDirection="column" width={columns} height={rows} backgroundColor={theme.bg} padding={2}>
    <Box>
      <Text bold color={theme.accent}>Bitori CLI</Text>
      <Text color={theme.faint}> · 选择模型配置</Text>
    </Box>
    <Box marginTop={1}><Text color={theme.dim}>选择要使用的模型配置</Text></Box>
    <Box flexDirection="column" marginTop={1}>
      {profiles.map((profile, index) => {
        const active = index === selected;
        return <Box key={profile.name}>
          <Text color={active ? theme.accent : theme.faint}>{active ? '❯ ' : '  '}</Text>
          <Text bold={active} color={active ? theme.text : theme.dim}>{profile.name}</Text>
          <Text color={theme.faint}> · {profile.model} · {profile.protocol}</Text>
        </Box>;
      })}
    </Box>
    <Box marginTop={1}><Text color={theme.faint}>↑/↓ 选择 · Enter 确认 · Ctrl+C 退出</Text></Box>
  </Box>;
}
