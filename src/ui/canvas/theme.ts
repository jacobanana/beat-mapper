// Colours come from the CSS custom properties, so the canvas follows the light/dark theme.

export const COLOR_KEYS = ['bg', 'panel', 'raise', 'line', 'ink', 'dim', 'wave', 'mark', 'beat', 'down', 'play', 'stage', 'start', 'slice', 'kick', 'snare', 'hat'] as const;
export type Colors = Record<(typeof COLOR_KEYS)[number], string>;

export function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement), c = {} as Colors;
  for (const k of COLOR_KEYS) c[k] = cs.getPropertyValue('--' + k).trim();
  return c;
}

export function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export const FONT = '"Barlow Semi Condensed","Arial Narrow",Arial,sans-serif';
