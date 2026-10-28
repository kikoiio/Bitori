import type {ApprovalDecision, ToolApprovalPrompt, ToolCall} from './types.js';

interface Pending {prompt: ToolApprovalPrompt; resolve: (decision: ApprovalDecision) => void}

/** 同一时刻只发布一个副作用审批；取消会拒绝所有尚未决定的调用。 */
export class ApprovalCoordinator {
  #pending: Pending | undefined;
  readonly #listeners = new Set<(prompt: ToolApprovalPrompt | null) => void>();
  subscribe(listener: (prompt: ToolApprovalPrompt | null) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  current(): ToolApprovalPrompt | null { return this.#pending?.prompt ?? null; }
  async request(call: ToolCall, force = false, reason?: string, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (call.effect === 'read' && !force) return 'approved';
    if (this.#pending) throw new Error('已有工具正在等待审批');
    const prompt: ToolApprovalPrompt = {callId: call.internalId, toolName: call.name, effect: call.effect, argumentSummary: JSON.stringify(call.arguments), riskMessage: call.effect === 'command' ? '批准的命令可能访问网络、启动子进程或影响工作区外资源。' : null, ...(reason === undefined ? {} : {reason})};
    return new Promise(resolve => {
      const abort = () => this.resolve(call.internalId, 'denied');
      this.#pending = {prompt, resolve: decision => { signal?.removeEventListener('abort', abort); resolve(decision); }};
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort(); else this.#emit(prompt);
    });
  }
  resolve(callId: string, decision: ApprovalDecision): void { if (!this.#pending || this.#pending.prompt.callId !== callId) return; const pending = this.#pending; this.#pending = undefined; pending.resolve(decision); this.#emit(null); }
  interruptAll(): void { if (this.#pending) this.resolve(this.#pending.prompt.callId, 'denied'); }
  #emit(prompt: ToolApprovalPrompt | null): void { for (const listener of this.#listeners) listener(prompt); }
}
