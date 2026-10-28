export const redactedPlaceholder = '<redacted>';

// 全局默认脱敏器：组合根在启动时注入；未注入时恒等，测试可直接构造。
let globalRedactor: (text: string) => string = text => text;

export function setGlobalRedactor(redactor: (text: string) => string): void {
  globalRedactor = redactor;
}

export function getGlobalRedactor(): (text: string) => string {
  return globalRedactor;
}

/**
 * 按精确串替换的脱敏器：trace 与日志共用同一实现。
 * 只处理长度 ≥ 8 的密钥值，避免把短变量名或普通数字误伤；长密钥优先替换，
 * 防止一个值是另一个值前缀时留下残余。
 */
export function createRedactor(secretValues: Iterable<string>): (text: string) => string {
  const unique = [...new Set([...secretValues].filter(value => value.length >= 8))].sort((a, b) => b.length - a.length);
  if (unique.length === 0) return text => text;
  return (text: string) => {
    let result = text;
    for (const secret of unique) {
      if (result.includes(secret)) result = result.replaceAll(secret, redactedPlaceholder);
    }
    return result;
  };
}
