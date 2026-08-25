import {Box, Text} from 'ink';
import type {ToolApprovalPrompt} from '../../tools/types.js';
/** [s05] 人在回路提供本次、会话、永久和拒绝四种决定。 */
export function ToolApprovalPanel({prompt}: {prompt: ToolApprovalPrompt}) { return <Box borderStyle="round" borderColor="yellow" flexDirection="column"><Text bold>工具审批：{prompt.toolName}</Text><Text>{prompt.argumentSummary}</Text>{prompt.reason ? <Text color="yellow">原因：{prompt.reason}</Text> : null}{prompt.riskMessage ? <Text color="yellow">{prompt.riskMessage}</Text> : null}<Text>Y 批准(本次) / S 本会话 / P 永久 / N 拒绝 / Ctrl+C 取消</Text></Box>; }
