/** Devin CLI 风格配色：深色石板底、暖橙强调、低饱和辅助色。 */
export const theme = {
  bg: '#1d2027',
  panel: '#262a33',
  panelStrong: '#2d323d',
  userBar: '#2a2f39',
  border: '#3b414d',
  borderSoft: '#30353f',
  text: '#e7e9ee',
  dim: '#9aa1ad',
  faint: '#6b727e',
  accent: '#f0a04b',
  accentSoft: '#b97a12',
  green: '#8bd17c',
  red: '#f2777a',
  yellow: '#e5c07b',
  blue: '#7aa2f7',
} as const;

/** 0 紧凑、1 标准、2 宽松；Ctrl+- / Ctrl+= 在 TUI 内调整排版密度。 */
export type Density = 0 | 1 | 2;

export function densityGap(density: Density): number {
  if (density === 0) return 0;
  return density === 1 ? 1 : 2;
}
