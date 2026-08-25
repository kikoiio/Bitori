/** [s01] 快捷键名称的集中说明；as const 保留每个值的字符串字面量类型。 */
export const keys = {
  send: 'enter',
  cancelOrExit: 'ctrl+c',
  newSession: 'ctrl+n',
  openSessions: 'ctrl+o',
  focus: 'tab',
  pageUp: 'pageup',
  pageDown: 'pagedown',
  close: 'escape',
} as const;
