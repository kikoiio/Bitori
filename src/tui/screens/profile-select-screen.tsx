import {Box, Text, useInput} from 'ink';
import {useRef, useState} from 'react';
import type {ProfileSummary} from '../../config/types.js';

export interface ProfileSelectScreenProps {
  profiles: ProfileSummary[];
  onSelect: (profile: ProfileSummary) => void;
  onExit: () => void;
}

export function ProfileSelectScreen({profiles, onSelect, onExit}: ProfileSelectScreenProps) {
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
  return <Box flexDirection="column" padding={1}>
    <Text bold color="cyan">选择模型配置</Text>
    {profiles.map((profile, index) => <Text key={profile.name} inverse={index === selected}>
      {index === selected ? '› ' : '  '}{profile.name} · {profile.protocol} · {profile.model}
    </Text>)}
    <Text color="gray">↑/↓ 选择 · Enter 确认 · Ctrl+C 退出</Text>
  </Box>;
}
