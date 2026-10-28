/** v4 之前的活动记录没有 owner，升级时无法判断旧进程是否仍在运行；迁移边界统一闭合一次。 */
export const recoverLegacyLiveStateMigration = {version: 6, sql: `
  UPDATE messages SET status='failed', error_code='stream_interrupted', error_message='程序中断，Agent 未自动续跑', updated_at=CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE status='streaming' AND owner_pid IS NULL;
  UPDATE tool_calls SET approval_status=CASE WHEN approval_status='pending' THEN 'denied' ELSE approval_status END,
    execution_status='interrupted',
    result_json='{"status":"interrupted","error":{"code":"interrupted","message":"程序中断，工具未自动重试","retryable":false}}',
    updated_at=CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE (execution_status IN ('queued','running') OR approval_status='pending')
      AND (agent_run_id IS NULL OR agent_run_id IN (SELECT id FROM agent_runs WHERE status='running' AND owner_pid IS NULL));
  UPDATE agent_runs SET status='interrupted', stop_reason='process_interrupted', finished_at=CAST(strftime('%s','now') AS INTEGER) * 1000, updated_at=CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE status='running' AND owner_pid IS NULL;
`} as const;
