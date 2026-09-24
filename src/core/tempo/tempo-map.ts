import type { Anchor } from '../types';
import { type Meter, barQ } from './meter';

export interface Bar {
  /** Bar index, 0 = bar 1. */
  readonly b: number;
  readonly ts: number;
  readonly te: number;
  readonly bpm: number;
}

/**
 * Positions to times and back, and nothing more: what a warp follows. The tempo map is one; the
 * warp's alignment (`core/warp/markers.ts`) is another, which says where the audio goes and so has no
 * tempo, bars or beats to give.
 */
export interface PositionMap {
  readonly isEmpty: boolean;
  /** Its points, sorted by q. */
  readonly anchors: readonly Anchor[];
  posToTime(q: number): number;
  timeToPos(t: number): number;
}

/**
 * Where every musical position falls in time: straight lines between pins, the tempo of the last
 * segment carried outwards, or `baseBpm` everywhere when there is a single pin. Immutable. This is
 * the music: bars, beats and tempo are only ever read from it.
 */
export class TempoMap implements PositionMap {
  /** Pins, sorted by q. */
  readonly anchors: readonly Anchor[];

  constructor(anchors: readonly Anchor[], readonly baseBpm: number) {
    this.anchors = [...anchors].sort((a, b) => a.q - b.q);
  }

  get isEmpty(): boolean {
    return this.anchors.length === 0;
  }

  /** The pin at bar 1, if any. */
  get downbeat(): Anchor | undefined {
    return this.anchors.find((a) => Math.abs(a.q) < 1e-9);
  }

  private seg(key: 'q' | 't', v: number): number {
    const A = this.anchors, n = A.length;
    if (v <= A[0][key]) return 0;
    if (v >= A[n - 1][key]) return n - 2;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m][key] <= v) lo = m; else hi = m; }
    return lo;
  }

  posToTime(q: number): number {
    const A = this.anchors;
    if (!A.length) return NaN;
    if (A.length === 1) return A[0].t + ((q - A[0].q) * 60) / this.baseBpm;
    const i = this.seg('q', q), a = A[i], b = A[i + 1];
    return a.t + ((q - a.q) * (b.t - a.t)) / (b.q - a.q);
  }

  timeToPos(t: number): number {
    const A = this.anchors;
    if (!A.length) return NaN;
    if (A.length === 1) return A[0].q + ((t - A[0].t) * this.baseBpm) / 60;
    const i = this.seg('t', t), a = A[i], b = A[i + 1];
    return a.q + ((t - a.t) * (b.q - a.q)) / (b.t - a.t);
  }

  /** Tempo in quarter notes per minute at time t. */
  bpmAt(t: number): number {
    if (!this.anchors.length) return NaN;
    const q = this.timeToPos(t), e = 0.01;
    return (60 * e) / (this.posToTime(q + e) - this.posToTime(q));
  }

  /** The pins either side of position q (excluding one at q itself). */
  neighbours(q: number): [Anchor | null, Anchor | null] {
    let p: Anchor | null = null, n: Anchor | null = null;
    for (const a of this.anchors) {
      if (a.q < q - 1e-6) p = a;
      else if (a.q > q + 1e-6) { n = a; break; }
    }
    return [p, n];
  }

  /** Every bar from bar 1 to the end of the audio, with its tempo. */
  bars(meter: Meter, dur: number): Bar[] {
    const out: Bar[] = [];
    if (!this.anchors.length) return out;
    const bq = barQ(meter);
    for (let b = 0; b < 5000; b++) {
      const ts = this.posToTime(b * bq);
      if (ts >= dur) break;
      const te = this.posToTime((b + 1) * bq);
      out.push({ b, ts, te, bpm: (60 * bq) / (te - ts) });
    }
    return out;
  }

  /** Bar and beat (both 0-based) at time t, or null in the lead-in before bar 1. */
  barBeatAt(t: number, meter: Meter): { bar: number; beat: number } | null {
    const q = this.timeToPos(t);
    if (!(q >= 0)) return null;
    const bq = barQ(meter), btq = 4 / meter.den;
    const bar = Math.floor(q / bq + 1e-9);
    return { bar, beat: Math.floor((q - bar * bq) / btq + 1e-9) };
  }

  /** The whole bar containing time t, clipped to the audio, or null before bar 1. */
  barRangeAt(t: number, meter: Meter, dur: number): { bar: number; a: number; b: number } | null {
    if (!this.anchors.length || this.timeToPos(t) < 0) return null;
    const bq = barQ(meter), bar = Math.floor(this.timeToPos(t) / bq + 1e-9);
    return { bar, a: this.posToTime(bar * bq), b: Math.min(dur, this.posToTime((bar + 1) * bq)) };
  }
}

/**
 * Every `stepQ` quarter notes from bar 1 of `map` that falls between times a (inclusive) and b:
 * `emit(time, k)`, k counting steps from bar 1 (negative in the lead-in). The metronome, the warp's
 * straight grid and Drums mode's fallback cuts all walk a grid this way.
 */
export function eachStep(map: PositionMap, stepQ: number, a: number, b: number, emit: (t: number, k: number) => void, limit = 1e6): void {
  if (map.isEmpty || !(b > a)) return;
  for (let k = Math.ceil(map.timeToPos(a) / stepQ - 1e-9), n = 0; n < limit; k++, n++) {
    const t = map.posToTime(k * stepQ);
    if (t >= b) break;
    if (t >= a) emit(t, k);
  }
}
