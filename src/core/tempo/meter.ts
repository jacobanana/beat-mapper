// Musical positions are quarter notes (q) from bar 1. A meter turns bars and beats into q.

export interface Meter {
  /** Beats per bar. */
  readonly num: number;
  /** Beat unit: 2, 4, 8 or 16. */
  readonly den: number;
}

export const DENOMINATORS = [2, 4, 8, 16] as const;
export const GRID_DIVISIONS = ['bar', '2', '4', '8', '16', '32', '4t', '8t', '16t'] as const;
export type GridDivision = (typeof GRID_DIVISIONS)[number];
/** Grid resolutions G / Shift+G step through, coarse to fine (no triplets). */
export const GRID_STEPS: readonly GridDivision[] = ['bar', '2', '4', '8', '16', '32'];

export const barQ = (m: Meter): number => (m.num * 4) / m.den;
export const beatQ = (m: Meter): number => 4 / m.den;

/** Grid lines of one resolution under a meter. Level 0 is a bar line, 1 a beat, 2 a subdivision. */
export class Grid {
  readonly barQ: number;
  readonly beatQ: number;
  /** Spacing of grid lines in quarter notes, never wider than a bar. */
  readonly stepQ: number;

  constructor(readonly meter: Meter, readonly division: GridDivision) {
    this.barQ = barQ(meter);
    this.beatQ = beatQ(meter);
    const m: Record<GridDivision, number> = { bar: this.barQ, '2': 2, '4': 1, '8': 0.5, '16': 0.25, '32': 0.125, '4t': 2 / 3, '8t': 1 / 3, '16t': 1 / 6 };
    this.stepQ = Math.min(m[division], this.barQ);
  }

  /** Level of the j-th line inside a bar. */
  level(j: number): 0 | 1 | 2 {
    if (j === 0) return 0;
    const r = (j * this.stepQ) / this.beatQ;
    return Math.abs(r - Math.round(r)) < 1e-6 ? 1 : 2;
  }

  /** The grid line closest to q, considering only lines up to maxLevel. */
  nearest(q: number, maxLevel = 2): number {
    const bq = this.barQ, gq = this.stepQ, b = Math.floor(q / bq + 1e-9);
    let best = b * bq, bd = Math.abs(q - best);
    const c2 = (b + 1) * bq;
    if (Math.abs(q - c2) < bd) { best = c2; bd = Math.abs(q - c2); }
    for (let j = 1; j * gq < bq - 1e-9; j++) {
      if (this.level(j) > maxLevel) continue;
      const c = b * bq + j * gq, d = Math.abs(q - c);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
}
