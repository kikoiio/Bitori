import {Box, Text} from 'ink';
import {theme} from '../theme.js';

/** 没有错误时返回 null；有错误时显示暖红提示条。 */
export function ErrorBanner({message}: {message: string | null}) {
  return message === null ? null : <Box borderStyle="round" borderColor={theme.red} paddingX={1} marginBottom={1}>
    <Text color={theme.red} wrap="wrap">! {message}</Text>
  </Box>;
}
