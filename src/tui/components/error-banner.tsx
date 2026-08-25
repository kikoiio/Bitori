import {Box, Text} from 'ink';

/** [s01] 没有错误时返回 null（React 不渲染任何内容），有错误时显示红色边框。 */
export function ErrorBanner({message}: {message: string | null}) {
  return message === null ? null : <Box borderStyle="single" borderColor="red" paddingX={1}><Text color="red" wrap="wrap">{message}</Text></Box>;
}
