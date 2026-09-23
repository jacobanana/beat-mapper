// The editor canvas, top to bottom: loop strip, bar ruler, waveform (edit half above, move half
// below up to Warp), tempo lane once there is a map, time ruler.

export const LOOPH = 20;
export const RULH = 22;
/** Bottom of the bar ruler: where the waveform starts. */
export const RUL = LOOPH + RULH;
export const TIME = 22;
/** Share of the waveform, from the top, where dragging edits instead of scrolling. */
export const EDIT = 0.5;

export interface Layout {
  w: number;
  h: number;
  /** Waveform top and height. */
  wy: number;
  wh: number;
  /** Top of the tempo lane (= bottom of the waveform). */
  ly: number;
  laneH: number;
  /** Top of the time ruler. */
  ty: number;
  /** Line between the edit and move halves. */
  ey: number;
}

export function layout(w: number, h: number, hasMap: boolean): Layout {
  const laneH = hasMap ? 50 : 0, wy = RUL, wh = Math.max(40, h - RUL - laneH - TIME), ly = wy + wh;
  return { w, h, wy, wh, ly, laneH, ty: ly + laneH, ey: wy + Math.round(wh * EDIT) };
}

export type Zone = 'loop' | 'bars' | 'edit' | 'nav' | 'time';

/** What a touch at height y does. In the Groove step the whole waveform is the drum lanes, all editable. */
export function zoneAt(L: Layout, y: number, step: number): Zone {
  if (y < LOOPH) return 'loop';
  if (y < RUL) return 'bars';
  if (y > L.h - TIME) return 'time';
  if (step === 5) return y < L.ly ? 'edit' : 'nav';
  return step <= 3 && y < RUL + L.wh * EDIT ? 'edit' : 'nav';
}

/** The Groove step's drum lanes, top to bottom. */
export const LANES = ['hat', 'snare', 'kick'] as const;

/** The drum lane at height y, if any. */
export function laneAt(L: Layout, y: number): (typeof LANES)[number] | null {
  const i = Math.floor(((y - L.wy) / L.wh) * 3);
  return y < L.ly && i >= 0 && i < 3 ? LANES[i] : null;
}
