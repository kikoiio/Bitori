import {Box, Text, useInput} from 'ink';
import {theme} from '../theme.js';

/** 终端不足 60×16 时显示的安全降级页，仍保留 Ctrl+C 退出能力。 */
export function TerminalTooSmallScreen({width, height, onExit}: {width: number; height: number; onExit: () => void}) {
  useInput((input, key) => { if (input === 'c' && key.ctrl) onExit(); });
  return <Box flexDirection="column" justifyContent="center" alignItems="center" width={width} height={height} backgroundColor={theme.bg}>
    <Text color={theme.yellow}>终端窗口过小</Text>
    <Text color={theme.dim}>当前 {width}×{height}，至少需要 60×16</Text>
    <Text color={theme.faint}>调整窗口大小，或按 Ctrl+C 退出</Text>
  </Box>;
}
