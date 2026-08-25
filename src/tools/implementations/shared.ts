import {ZodError} from 'zod';
import {TextFileError} from '../utf8.js';
import {WorkspacePathError} from '../workspace-paths.js';
import type {ToolError, ToolExecutionResult} from '../types.js';

export function toolError(code: ToolError['code'], message: string, details?: Record<string, unknown>): ToolExecutionResult {
  return {status: 'error', error: {code, message, retryable: false, ...(details ? {details} : {})}};
}

export function normalizeFileError(error: unknown): ToolExecutionResult {
  if (error instanceof WorkspacePathError || error instanceof TextFileError) return toolError(error.code, error.message);
  if (error instanceof ZodError) return toolError('invalid_arguments', '工具参数无效', {issues: error.issues});
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String(error.code);
    if (code === 'EACCES' || code === 'EPERM') return toolError('permission_denied', '没有权限完成文件操作');
    if (code === 'EEXIST') return toolError('path_already_exists', '目标已存在，不能覆盖');
    if (code === 'ENOENT') return toolError('path_not_found', '目标路径不存在');
  }
  return toolError('internal_error', error instanceof Error ? error.message : '未知内部错误');
}
