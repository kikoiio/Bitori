/** 将 Windows 与旧 Mac 换行统一为 LF，供所有 Markdown 边界解析器复用。 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
