import {Box} from 'ink';
import type {ToolCallRecord} from '../../storage/types.js';
import {ToolCallCard} from './tool-call-card.js';
export function ToolCallList({records}: {records: ToolCallRecord[]}) { return <Box flexDirection="column">{records.map(record => <ToolCallCard key={record.id} record={record} />)}</Box>; }
