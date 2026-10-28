import {Worker} from 'node:worker_threads';
import {createId} from '../shared/ids.js';
import {StorageError, errorMessage} from '../shared/errors.js';
import type {StorageOperation, StorageRequest, StorageResponse} from './worker-protocol.js';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class StorageWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<string, PendingRequest>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  public constructor(databasePath: string, workerUrl?: URL) {
    // 开发时本文件由 tsx 执行，但 Node Worker 仍指向已构建的 JS；生产构建后两者在同一目录。
    const defaultUrl = import.meta.url.endsWith('.ts')
      ? new URL('../../dist/storage/worker.js', import.meta.url)
      : new URL('./worker.js', import.meta.url);
    this.#worker = new Worker(workerUrl ?? defaultUrl, {workerData: {databasePath}});
    this.#worker.on('message', (response: StorageResponse) => this.#handleResponse(response));
    this.#worker.on('error', error => this.#rejectAll(new StorageError('存储 Worker 发生错误', {cause: error})));
    this.#worker.on('exit', code => {
      if (!this.#closed && code !== 0) this.#rejectAll(new StorageError(`存储 Worker 意外退出（${code}）`));
    });
  }

  public request(operation: StorageOperation): Promise<unknown> {
    if (this.#closed) return Promise.reject(new StorageError('存储已经关闭'));
    const requestId = createId();
    return new Promise((resolve, reject) => {
      // 按 requestId 将 Worker 响应与对应请求关联。
      this.#pending.set(requestId, {resolve, reject});
      const request: StorageRequest = {requestId, operation};
      this.#worker.postMessage(request);
    });
  }

  public close(): Promise<void> {
    // 多次关闭共用同一流程，避免重复释放资源。
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closePromise = (async () => {
      if (!this.#closed) {
        await this.request({type: 'close'});
        this.#closed = true;
      }
    })();
    return this.#closePromise;
  }

  #handleResponse(response: StorageResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) return;
    this.#pending.delete(response.requestId);
    if ('error' in response) pending.reject(new StorageError(response.error.message));
    else pending.resolve(response.result);
  }

  #rejectAll(error: Error): void {
    // Worker 崩溃时必须结束所有等待中的请求，避免永久悬挂。
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#closed = true;
  }
}

export function serializeWorkerError(error: unknown): {name: string; message: string} {
  return {name: error instanceof Error ? error.name : 'Error', message: errorMessage(error)};
}
