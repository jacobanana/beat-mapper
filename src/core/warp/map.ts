// Where each moment of the audio goes when it is warped onto a straight grid. The tempo map is
// straight lines between pins, so a straight grid is reached by moving every pin to where a steady
// tempo would put it: the warp is exact between pins with one point per pin.
import { barQ, beatQ, type Meter } from '../tempo/meter';
import { type PositionMap, TempoMap } from '../tempo/tempo-map';
import type { TimeRange } from '../types';

/**
 * A monotone, piecewise-linear map from source time to output time, both in seconds. Past its ends
 * it carries on at the slope of the end segments, so an algorithm can read context either side.
 */
export class WarpMap {
  constructor(readonly src: readonly number[], readonly dst: readonly number[]) {
    if (src.length < 2 || src.length !== dst.length) throw new Error('A warp map needs two points or more');
  }

  /** Output length, seconds. */
  get outDur(): number { return this.dst[this.dst.length - 1]; }

  srcAt(d: number): number { return interp(this.dst, this.src, d); }
  dstAt(s: number): number { return interp(this.src, this.dst, s); }

  /** How much the audio is stretched at output time d: above 1 it is slowed down. */
  ratioAt(d: number): number {
    const i = seg(this.dst, d);
    return (this.dst[i + 1] - this.dst[i]) / (this.src[i + 1] - this.src[i]);
  }

  /** The least and most any stretch of the audio is stretched. */
  ratioRange(): [number, number] {
    let lo = Infinity, hi = 0;
    for (let i = 0; i + 1 < this.src.length; i++) {
      const r = (this.dst[i + 1] - this.dst[i]) / (this.src[i + 1] - this.src[i]);
      if (r < lo) lo = r;
      if (r > hi) hi = r;
    }
    return [lo, hi];
  }
}

function seg(x: readonly number[], v: number): number {
  const n = x.length;
  if (v <= x[0]) return 0;
  if (v >= x[n - 1]) return n - 2;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] <= v) lo = m; else hi = m; }
  return lo;
}

function interp(x: readonly number[], y: readonly number[], v: number): number {
  const i = seg(x, v);
  return y[i] + ((v - x[i]) * (y[i + 1] - y[i])) / (x[i + 1] - x[i]);
}

/** What part of the audio is warped, and which musical position lands at the start of the file. */
export interface WarpRange extends TimeRange {
  /** Quarter notes from bar 1 at output time 0. */
  q0: number;
}

/**
 * The part to warp. A loop is warped on its own and starts the file. Otherwise the whole file is, and
 * either it starts on bar 1 (`trim`) or the lead-in is kept and silence is added before it, so that the
 * file starts on a bar line and drops into a DAW on the grid.
 */
export function warpRange(map: PositionMap, meter: Meter, dur: number, o: { lead: 'full' | 'trim'; loop: TimeRange | null }): WarpRange {
  if (o.loop) return { a: o.loop.a, b: o.loop.b, q0: map.timeToPos(o.loop.a) };
  const bar1 = map.posToTime(0);
  if (o.lead === 'trim' && bar1 > 0 && bar1 < dur) return { a: bar1, b: dur, q0: 0 };
  const bq = barQ(meter);
  return { a: 0, b: dur, q0: Math.floor(map.timeToPos(0) / bq + 1e-9) * bq };
}

/** The tempo the range averages, in quarter notes per minute: of the tempo map, never the alignment. */
export function averageBpm(map: TempoMap, r: TimeRange): number {
  return ((map.timeToPos(r.b) - map.timeToPos(r.a)) * 60) / (r.b - r.a);
}

/** The warp that puts every position of the tempo map on a steady `bpm`, over the range. */
export function planWarp(map: PositionMap, r: WarpRange, bpm: number): WarpMap {
  const ts = [r.a];
  for (const p of map.anchors) if (p.t > r.a + 1e-6 && p.t < r.b - 1e-6) ts.push(p.t);
  ts.push(r.b);
  return new WarpMap(ts, ts.map((t) => ((map.timeToPos(t) - r.q0) * 60) / bpm));
}

/**
 * The straight grid the warp puts the audio on, as a tempo map of the warped file: quarter note `q0`
 * at its start and one steady tempo. Its bars are the tempo map's, laid end to end at `bpm`. Pinned at
 * bar 1, wherever that falls, since the MIDI and REAPER writers start from the pin there.
 */
export function gridMap(q0: number, bpm: number): TempoMap {
  return new TempoMap([{ q: 0, t: (-q0 * 60) / bpm, manual: true }], bpm);
}

/**
 * The beats of the straight grid between output times a and b, for a metronome over the warped audio:
 * `emit(time, downbeat)`. Output time 0 is quarter note `q0`.
 */
export function gridBeats(q0: number, bpm: number, meter: Meter, a: number, b: number, emit: (t: number, down: boolean) => void): void {
  const bq = beatQ(meter), spq = 60 / bpm;
  for (let k = Math.ceil((q0 + a / spq) / bq - 1e-9) || 0; ; k++) {
    const t = (k * bq - q0) * spq;
    if (t >= b) break;
    if (t >= a) emit(t, ((k % meter.num) + meter.num) % meter.num === 0);
  }
}
