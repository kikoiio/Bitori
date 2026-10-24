export interface TaskDefinition {
  id: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  skills: string[];
  task: string;
  maxIterations?: number;
  forbiddenTools?: string[];
  expectReplyContains?: string[];
}

export interface TaskResult {
  taskId: string;
  model: string;
  provider: string;
  status: 'pass' | 'fail' | 'error';
  exitCode: number;
  exitReason: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  toolSequence: string[];
  reply: string;
  error: string | null;
  durationMs: number;
}

export interface RunLedger {
  runId: string;
  startedAt: string;
  provider: string;
  model: string;
  results: TaskResult[];
  summary: {passed: number; failed: number; errored: number; total: number; passRate: number};
}
