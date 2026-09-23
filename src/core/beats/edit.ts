// Edits to the tempo map, as pure functions: each takes the current pins and returns new ones (or
// says why it can't), never touching anything else. The app records the result for undo.
import { type Grid, type Meter, barQ, beatQ } from '../tempo/meter';
import { TempoMap } from '../tempo/tempo-map';
import type { Anchor, TimeRange } from '../types';
import { type Hit, autoMap, trackBeats } from './track';

export const MIN_BPM = 20;
export const MAX_BPM = 400;
export const clampBpm = (b: number): number => Math.max(MIN_BPM, Math.min(MAX_BPM, b));

/** Pins must stay this far from their neighbours. */
const PIN_GAP = 0.005;

export type PinResult = { ok: true; anchors: Anchor[]; pinned: Anchor } | { ok: false; reason: 'before-bar-1' | 'crosses-neighbour' };

/** Bar 1 starts at T. The pins after T keep their bar positions, shifted to count from here. */
export function setDownbeat(map: TempoMap, grid: Grid, T: number): Anchor[] {
  if (map.anchors.length <= 1) return [{ q: 0, t: T, manual: true }];
  const qg = grid.nearest(map.timeToPos(T));
  const rest = map.anchors.map((a) => ({ ...a, q: a.q - qg })).filter((a) => a.q > 1e-6 && a.t > T + 0.01);
  return [{ q: 0, t: T, manual: true }, ...rest];
}

/** Bar 1 on the first transient (or the very start), when nothing is pinned yet. */
export function ensureDownbeat(anchors: readonly Anchor[], markers: readonly Hit[]): Anchor[] | null {
  if (anchors.length) return null;
  return [{ q: 0, t: markers.length ? markers[0].t : 0, manual: true }];
}

/** Pins position q (the grid line nearest T unless given) to time T. */
export function pinAt(map: TempoMap, grid: Grid, T: number, qOverride?: number): PinResult {
  if (map.isEmpty) {
    const anchors = setDownbeat(map, grid, T);
    return { ok: true, anchors, pinned: anchors[0] };
  }
  const q = qOverride ?? grid.nearest(map.timeToPos(T));
  if (q < -1e-6) return { ok: false, reason: 'before-bar-1' };
  const [p, n] = map.neighbours(q);
  if ((p && T <= p.t + PIN_GAP) || (n && T >= n.t - PIN_GAP)) return { ok: false, reason: 'crosses-neighbour' };
  const pinned: Anchor = { q, t: T, manual: true };
  const i = map.anchors.findIndex((k) => Math.abs(k.q - q) < 1e-6);
  const anchors = i >= 0 ? map.anchors.map((a, j) => (j === i ? { ...pinned, q: a.q } : a)) : [...map.anchors, pinned];
  anchors.sort((a, b) => a.q - b.q);
  return { ok: true, anchors, pinned: i >= 0 ? anchors.find((a) => Math.abs(a.q - q) < 1e-6)! : pinned };
}

/** Removes a pin. Bar 1 can't be removed, only moved. */
export function unpin(map: TempoMap, q: number): Anchor[] | null {
  if (q === 0) return null;
  return map.anchors.filter((a) => a.q !== q);
}

/** Keeps only bar 1. */
export function clearPins(map: TempoMap): Anchor[] {
  return map.anchors.filter((a) => a.q === 0);
}

/** Moves pin q to time t, kept between its neighbours. */
export function moveAnchor(map: TempoMap, q: number, t: number, dur: number): Anchor[] {
  const [p, n] = map.neighbours(q);
  const lone = map.anchors.length === 1;
  const lo = lone ? 0 : p ? p.t + PIN_GAP : 0, hi = lone ? dur : n ? n.t - PIN_GAP : dur;
  const tt = Math.max(lo, Math.min(hi, t));
  return map.anchors.map((a) => (a.q === q ? { q: a.q, t: tt, manual: true } : a));
}

/** Half or double time: every pin's position scales, and so does the starting tempo. */
export function scaleTempo(anchors: readonly Anchor[], baseBpm: number, f: number): { anchors: Anchor[]; baseBpm: number } {
  return { anchors: anchors.map((a) => ({ ...a, q: a.q * f })), baseBpm: clampBpm(baseBpm * f) };
}

export interface MapSettings {
  /** Pin every beat or every bar. */
  mapEvery: 'beat' | 'bar';
  /** Search window, percent of a beat. */
  tol: number;
}

const trackOpts = (meter: Meter, s: MapSettings, dur: number) => ({
  stepQ: s.mapEvery === 'bar' ? barQ(meter) : beatQ(meter),
  beatQ: beatQ(meter),
  tolFrac: s.tol / 100,
  dur,
});

/** Re-runs the beat tracking from bar 1 and the user's own pins, replacing every found pin. */
export function autoMapFromPins(map: TempoMap, markers: readonly Hit[], meter: Meter, s: MapSettings, dur: number): Anchor[] {
  return autoMap(map.anchors.filter((a) => a.manual || a.q === 0), markers, { ...trackOpts(meter, s, dur), spq: 60 / map.baseBpm });
}

export type DeriveHow = { kind: 'loop'; bars: number } | { kind: 'pins'; count: number };
export interface DeriveResult {
  anchors: Anchor[];
  /** The loop's tempo, unrounded. */
  bpm: number;
  /** The new starting tempo: the loop's, rounded to 0.01 and clamped. */
  baseBpm: number;
  how: DeriveHow;
}

/**
 * Derive from loop: the loop is the part that is right, so its tempo is followed outwards in both
 * directions and the rest of the map is rebuilt around it. Two or more pins inside the loop are kept
 * as they are; otherwise the loop is taken as a whole number of bars (`loopBars`, or the count its
 * length comes closest to at the current tempo). Bar 1 stays where it was, or goes to the first
 * transient when there was none.
 */
export function deriveFromLoop(
  map: TempoMap,
  markers: readonly Hit[],
  loop: TimeRange,
  meter: Meter,
  s: MapSettings,
  dur: number,
  loopBars?: number,
): DeriveResult {
  const { a, b } = loop, bq = barQ(meter);
  const old = map.downbeat, oldT = old ? old.t : null;
  let seeds = map.anchors.filter((k) => k.t >= a - 0.02 && k.t <= b + 0.02).map((k) => ({ q: k.q, t: k.t }));
  let how: DeriveHow;
  if (seeds.length < 2) {
    let n = Math.round(loopBars || 0) || 0;
    if (n < 1) n = Math.max(1, Math.round((b - a) / ((bq * 60) / map.baseBpm)));
    const qa = map.anchors.length ? Math.round(map.timeToPos(a) / bq) * bq : 0;
    seeds = [{ q: qa, t: a }, { q: qa + n * bq, t: b }];
    how = { kind: 'loop', bars: n };
  } else how = { kind: 'pins', count: seeds.length };

  type Beat = { q: number; t: number; matched: boolean; seed?: boolean };
  const first = seeds[0], last = seeds[seeds.length - 1], per = (last.t - first.t) / (last.q - first.q);
  const o = { ...trackOpts(meter, s, dur), stopT: 0 };
  const fwd = trackBeats(markers, last.q, last.t, per, 1, o), back = trackBeats(markers, first.q, first.t, per, -1, o);
  const inner: Beat[] = seeds.length === 2 && how.kind === 'loop'
    ? autoMap(seeds, markers, { ...o, spq: per, dur: last.t })
        .filter((k) => !k.manual && k.q > first.q && k.q < last.q)
        .map((k) => ({ q: k.q, t: k.t, matched: true }))
    : [];
  const all: Beat[] = [
    ...back.reverse(),
    { ...first, matched: true, seed: true },
    ...inner,
    ...seeds.slice(1).map((k) => ({ ...k, matched: true, seed: true })),
    ...fwd,
  ];
  const onBar = all.filter((k) => Math.abs(k.q / bq - Math.round(k.q / bq)) < 1e-6);
  let one: Beat | null = null;
  if (oldT != null) {
    for (const k of onBar) if (!one || Math.abs(k.t - oldT) < Math.abs(one.t - oldT)) one = k;
  } else {
    const t1 = (markers.length ? markers[0].t : 0) - 0.05;
    one = onBar.find((k) => k.t >= t1) || onBar[0] || null;
  }
  const shift = one ? one.q : first.q;
  const anchors: Anchor[] = all
    .filter((k) => k.matched || k === one)
    .map((k) => ({ q: k.q - shift, t: k.t, manual: !!k.seed || k === one }))
    .filter((k) => k.q >= -1e-9);
  if (anchors[0]) anchors[0] = { ...anchors[0], q: 0 };
  return { anchors, bpm: 60 / per, baseBpm: clampBpm(+(60 / per).toFixed(2)), how };
}

/** Tap tempo: the average of the last few taps, once there are three within two seconds of each other. */
export class TapTempo {
  private taps: number[] = [];

  /** Records a tap at `now` (ms). Returns the tempo in quarter notes per minute, or null if too few taps. */
  tap(now: number, meter: Meter): { bpm: number; first: boolean } | null {
    const T = this.taps;
    if (T.length && now - T[T.length - 1] > 2000) T.length = 0;
    T.push(now);
    if (T.length > 8) T.shift();
    if (T.length < 3) return null;
    const bpm = ((60000 * (T.length - 1)) / (T[T.length - 1] - T[0])) * beatQ(meter);
    return { bpm: clampBpm(+bpm.toFixed(1)), first: T.length === 3 };
  }
}
