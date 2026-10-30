import {Box} from 'ink';
import {useState} from 'react';
import type {ToolCallRecord} from '../../storage/types.js';
import {ToolCallCard} from './tool-call-card.js';

interface ToolCallListProps {
  records: ToolCallRecord[];
  forceExpanded?: boolean;
}

export function ToolCallList({records, forceExpanded = false}: ToolCallListProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  
  const toggleExpand = (id: string) => {
    const newSet = new Set(expandedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setExpandedIds(newSet);
  };

  return (
    <Box flexDirection="column">
      {records.map(record => (
        <ToolCallCard
          key={record.id}
          record={record}
          expanded={forceExpanded || expandedIds.has(record.id)}
          onToggle={() => toggleExpand(record.id)}
        />
      ))}
    </Box>
  );
}
