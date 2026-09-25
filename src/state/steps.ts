// The six steps, in the order the work goes. The session stores a step by its number.
export type Step = 1 | 2 | 3 | 4 | 5 | 6;

export const STEP = { transients: 1, beats: 2, warp: 3, slice: 4, groove: 5, notes: 6 } as const satisfies Record<string, Step>;
export const STEPS: readonly Step[] = [1, 2, 3, 4, 5, 6];
