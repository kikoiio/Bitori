/** 项目自定义错误的共同基类，便于调用方按错误类别处理。 */
export class BitoriError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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
