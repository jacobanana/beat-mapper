// The warp, described once: what is warped and how (`WarpPlan`), and the file it makes (`WarpOut`).
// Playback, the timeline, Slice, Groove and the exports all read these, so where a moment of the
// original lands in the warp, the part warped and the straight grid are each worked out in one place.
import type { TempoMap } from '../core/tempo/tempo-map';
import type { Meter } from '../core/tempo/meter';
import type { TimeRange } from '../core/types';
import { type WarpMap, type WarpRange, beatsOf, gridMap } from '../core/warp/map';
import type { Alignment } from '../core/warp/markers';

/** What would be warped onto a straight grid, and how. */
export interface WarpPlan {
  map: WarpMap;
  bpm: number;
  /** The tempo the part being warped averages. */
  avgBpm: number;
  /** Quarter notes from bar 1 at the start of the warped audio. */
  q0: number;
  /** The part of the original warped, in its own seconds, and the position at the file's start. */
  range: WarpRange;
  /** Source seconds warped, and output seconds. */
  srcDur: number;
  outDur: number;
  /** The least and most anything is stretched: above 1 is slowed down. */
  ratios: [number, number];
  loop: boolean;
  /**
   * What it was made from: the tempo map (the music, and the editor's axis) and the alignment (where
   * the warp puts the audio). A take keeps playing after an edit until the next one is ready, and the
   * editor draws it from these, not from the document as it is now.
   */
  tempo: TempoMap;
  alignment: Alignment;
}

/**
 * The warp as it is heard and exported: the file it makes, on its own steady grid, and where each
 * moment of the original lands in it. Transients, slices and hits keep their original times; this
 * places them.
 */
export interface WarpOut {
  plan: WarpPlan;
  /** The warped file's tempo map: one steady tempo, quarter note `plan.q0` at its start. */
  map: TempoMap;
  /**
   * The tempo map a DAW gets with the warped file: its own, but for a loop, which starts the file, bar 1
   * is at its start.
   */
  exportMap: TempoMap;
  /** The part of the original that is warped, in its own seconds. */
  range: TimeRange;
  /** Where the moment at original time t is in the warped file. */
  at(t: number): number;
  /** The original time heard at time o of the warped file, within the audio. */
  source(o: number): number;
  /** The beats of its straight grid between its times a and b, for the metronome. */
  beats(a: number, b: number, emit: (t: number, down: boolean) => void): void;
}

export function warpOut(plan: WarpPlan, meter: Meter, dur: number): WarpOut {
  const m = plan.map, map = gridMap(plan.q0, plan.bpm);
  return {
    plan,
    map,
    exportMap: plan.loop ? gridMap(0, plan.bpm) : map,
    range: { a: plan.range.a, b: plan.range.b },
    at: (t) => m.dstAt(t),
    source: (o) => Math.max(0, Math.min(dur, m.srcAt(o))),
    beats: (a, b, emit) => beatsOf(map, meter, a, b, emit),
  };
}
