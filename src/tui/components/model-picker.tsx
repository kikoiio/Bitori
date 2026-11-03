import {Box, Text} from 'ink';
import type {ProfileSummary} from '../../config/types.js';
import type {RemoteModel} from '../../diagnostics/connection.js';
import {theme} from '../theme.js';

interface ModelPickerProps {
  profiles: ProfileSummary[];
  selectedIndex: number;
  currentName: string;
  switching: boolean;
  /** profiles = 选择配置；models = 在所选配置内挑 Provider 上报的真实模型。 */
  stage?: 'profiles' | 'models';
  modelProfile?: {name: string; model: string};
  models?: RemoteModel[];
  modelsLoading?: boolean;
  modelsNote?: string;
  modelsError?: string;
  modelSelectedIndex?: number;
}

/** /model 打开的配置选择面板；切换会重建控制器并加载该配置最近的会话。 */
export function ModelPicker({
  profiles, selectedIndex, currentName, switching,
  stage = 'profiles', modelProfile, models = [], modelsLoading = false, modelsNote, modelsError, modelSelectedIndex = 0,
}: ModelPickerProps) {
  if (stage === 'models') {
    const rows = [{id: '', label: `保持配置默认（${modelProfile?.model ?? '-'}）`}, ...models.map(model => ({id: model.id, label: model.displayName === undefined || model.displayName === model.id ? model.id : `${model.id} · ${model.displayName}${model.enabled ? '' : '（未启用）'}`}))];
    const index = Math.max(0, Math.min(modelSelectedIndex, rows.length - 1));
    return <Box borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} flexDirection="column" paddingX={1} marginX={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.text}>选择模型 · {modelProfile?.name ?? ''}</Text>
        <Text color={theme.faint}>{switching ? '正在切换…' : '↑↓ 选择 · Enter 确认 · Esc 返回'}</Text>
      </Box>
      {modelsLoading ? <Text color={theme.dim}>正在向 Provider 查询模型列表…</Text> : null}
      {!modelsLoading && rows.length > 1 ? rows.map((row, rowIndex) => <Box key={row.id || '__default__'}>
        <Text color={rowIndex === index ? theme.accent : theme.faint}>{rowIndex === index ? '❯ ' : '  '}</Text>
        <Text bold={rowIndex === index} color={rowIndex === index ? theme.text : theme.dim}>{row.label}</Text>
      </Box>) : null}
      {!modelsLoading && rows.length === 1 ? <Text color={theme.faint}>{modelsError ?? '该 Provider 未提供模型列表；将直接使用配置中的模型名。'}</Text> : null}
      {modelsNote !== undefined ? <Text color={theme.dim}>{modelsNote}</Text> : null}
      {modelsError !== undefined && rows.length > 1 ? <Text color={theme.yellow}>{modelsError}</Text> : null}
    </Box>;
  }
  return <Box borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} flexDirection="column" paddingX={1} marginX={1} marginBottom={1}>
    <Box justifyContent="space-between">
      <Text bold color={theme.text}>选择模型配置</Text>
      <Text color={theme.faint}>{switching ? '正在切换…' : '↑↓ 选择 · Enter 确认 · Esc 取消'}</Text>
    </Box>
    {profiles.length === 0 ? <Text color={theme.faint}>没有可用配置 — 运行 bitori doctor 检查，或编辑 ~/.bitori/config.yaml 添加 profile</Text> : profiles.map((profile, index) => {
      const selected = index === selectedIndex;
      const current = profile.name === currentName;
      return <Box key={profile.name}>
        <Text color={selected ? theme.accent : theme.faint}>{selected ? '❯ ' : '  '}</Text>
        <Text bold={selected} color={selected ? theme.text : theme.dim}>{current ? '● ' : '○ '}{profile.name}</Text>
        <Text color={theme.faint}> · {profile.model} · {profile.protocol}</Text>
      </Box>;
    })}
    <Text color={theme.faint}>Enter 后可查看该配置的可用模型</Text>
  </Box>;
}
