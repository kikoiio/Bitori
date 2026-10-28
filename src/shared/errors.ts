/** 项目自定义错误的共同基类，便于调用方按错误类别处理。 */
export class BitoriError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // new.target 指向实际被 new 的子类，因此 name 会是 ConfigurationError 等具体名称。
    this.name = new.target.name;
  }
}

export class ConfigurationError extends BitoriError {}

export class StorageError extends BitoriError {}

export class UsageError extends BitoriError {}

export function errorMessage(error: unknown): string {
  // 对未知抛出值做统一且安全的字符串化。
  return error instanceof Error ? error.message : String(error);
}
