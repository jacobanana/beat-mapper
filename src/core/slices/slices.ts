import type { TimeRange } from '../types';

export interface Slice {
  /** Index in the plan. */
  readonly i: number;
  readonly t0: number;
  readonly t1: number;
  /** Where the next slice starts (or the end of the range). */
  readonly next: number;
}

export interface SlicePlanOptions {
  dur: number;
  from?: number;
  to?: number;
  /** Seconds; a transient closer than this to the previous slice's start is passed over. */
  minLen?: number;
  mode: 'gap' | 'fixed';
  /** Fixed mode: slice length, seconds. */
  len: number;
  /** Gap mode: audio kept past the next transient, seconds. */
  tail?: number;
}

// Every transient starts a slice. A transient closer than minLen to the one that started the previous
// slice is passed over, so that slice simply keeps running. In 'gap' mode a slice runs to the next
// transient plus a tail, in 'fixed' mode for a set length; either way it stops at the end of the file.
export function planSlices(times: readonly number[], o: SlicePlanOptions): Slice[] {
  const dur = o.dur, from = Math.max(0, o.from || 0), to = Math.min(dur, o.to == null ? dur : o.to), minLen = o.minLen || 0;
  const B: number[] = [];
  for (const t of times) {
    if (t < from - 1e-9 || t >= to - 1e-6) continue;
    if (B.length && t - B[B.length - 1] < minLen) continue;
    B.push(t);
  }
  const out: Slice[] = [];
  for (let i = 0; i < B.length; i++) {
    const t0 = B[i], next = i + 1 < B.length ? B[i + 1] : to;
    const t1 = Math.min(dur, o.mode === 'fixed' ? t0 + o.len : next + (o.tail || 0));
    if (t1 - t0 < 0.002) continue;
    out.push({ i: out.length, t0, t1, next });
  }
  return out;
}

export interface RenderOptions {
  /** Seconds. */
  fadeIn?: number;
  /** Seconds. */
  fadeOut?: number;
  mono?: boolean;
  normalize?: boolean;
  /** Linear peak to normalize to. */
  target?: number;
}

export interface RenderedAudio {
  chans: Float32Array[];
  n: number;
  sr: number;
  peak: number;
}

// One slice, exactly as it will be written: the samples between t0 and t1, raised-cosine fades at both
// ends so nothing clicks, optionally mixed to mono and normalized to a target peak.
export function renderSlice(chans: readonly Float32Array[], sr: number, t0: number, t1: number, o: RenderOptions = {}): RenderedAudio {
  const len = chans[0].length, s0 = Math.max(0, Math.round(t0 * sr)), s1 = Math.max(s0 + 1, Math.min(len, Math.round(t1 * sr))), n = s1 - s0;
  const out: Float32Array[] = [];
  if (o.mono && chans.length > 1) {
    const m = new Float32Array(n);
    for (const c of chans) for (let i = 0; i < n; i++) m[i] += c[s0 + i] / chans.length;
    out.push(m);
  } else {
    for (const c of chans) { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = c[s0 + i]; out.push(d); }
  }
  const fi = Math.min(n, Math.round((o.fadeIn || 0) * sr)), fo = Math.min(n, Math.round((o.fadeOut || 0) * sr));
  for (const d of out) {
    for (let i = 0; i < fi; i++) d[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
    for (let i = 0; i < fo; i++) d[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
  }
  let peak = 0;
  for (const d of out) for (let i = 0; i < n; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; }
  if (o.normalize && peak > 1e-6) {
    const tg = o.target == null ? 0.891 : o.target, gain = tg / peak;
    for (const d of out) for (let i = 0; i < n; i++) d[i] *= gain;
    peak = tg;
  }
  return { chans: out, n, sr, peak };
}

/** A slice's start time to the millisecond: how dropped slices are remembered. */
export const sliceKey = (t: number): number => Math.round(t * 1000);

/** Whether a slice starting at t0 is among the excluded start times (±1 ms). */
export function isExcluded(excluded: ReadonlySet<number>, t0: number): boolean {
  const k = sliceKey(t0);
  return excluded.has(k) || excluded.has(k - 1) || excluded.has(k + 1);
}

export interface LoopInfo extends TimeRange {
  dur: number;
  bars: number;
  bpm: number;
}

// What the loop is worth musically: the bar count it comes closest to, and the tempo that bar count
// implies for its exact length – so the name a loop is saved under always adds up. `quarters` is the
// loop's length in quarter notes as the tempo map reads it.
export function loopInfo(loop: TimeRange, quarters: number, barLenQ: number): LoopInfo {
  const dur = loop.b - loop.a, bars = Math.max(1, Math.round(quarters / barLenQ));
  return { a: loop.a, b: loop.b, dur, bars, bpm: (60 * bars * barLenQ) / dur };
}
