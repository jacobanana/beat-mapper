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

export interface SteadyResult {
  /** One pin, bar 1: the map is one steady tempo from there. */
  anchors: Anchor[];
  /** The tempo, quarter notes per minute, not rounded: over a long take a rounded tempo drifts. */
  bpm: number;
  /** The tempo the loop alone gives, before the fit. */
  loopBpm: number;
  /** Transients the fit used; 0 when it didn't run or found too few. */
  fitted: number;
  /** The bar line at the start of the loop, after the fit. */
  ref: number;
}

/**
 * Steady from loop: one tempo for the whole take, for a part played to a click, where following every
 * beat would write the player's small drift into the map. The loop is `bars` bars, and its start is a
 * bar line. With `fit`, the tempo and that bar line are then fitted to every transient near a beat
 * (weighted least squares, stray hits dropped), starting from the loop and widening outwards, so an
 * error of a few milliseconds at the loop's edges doesn't add up over the take. Bar 1 is a whole number
 * of bars before the loop's start: the bar line nearest where bar 1 was, or else the first transient.
 */
export function steadyFromLoop(
  markers: readonly Hit[],
  loop: TimeRange,
  meter: Meter,
  bars: number,
  o: { downbeat: number | null; fit: boolean; dur: number },
): SteadyResult {
  const bq = barQ(meter), btq = beatQ(meter), n = Math.max(1, Math.round(bars));
  let spq = (loop.b - loop.a) / (n * bq), ref = loop.a, fitted = 0;
  const loopBpm = 60 / spq;
  if (o.fit) {
    const spb0 = spq * btq;
    let tol = 0.1 * spb0;
    // How far past the loop the fit reaches: doubled each round until it covers the take, which is then
    // fitted once more with the window narrowed to the spread the fit found.
    let ext = Math.max(spb0 * 4, loop.b - loop.a), last = false;
    for (let round = 0; round < 40; round++) {
      const f = fitBeats(markers, ref, spq * btq, tol, loop.a - ext, loop.b + ext);
      // Too few hits to trust, or a tempo far from the loop's (not a take played to a click): what stands, stands.
      if (!f || Math.abs(f.spb / spb0 - 1) > 0.03) break;
      ref = f.t0;
      spq = f.spb / btq;
      fitted = f.n;
      tol = Math.max(0.01 * f.spb, Math.min(0.1 * f.spb, 3 * f.sd));
      if (last) break;
      if (loop.a - ext <= 0 && loop.b + ext >= o.dur) last = true;
      else ext *= 2;
    }
  }
  const barT = spq * bq, target = o.downbeat ?? (markers.length ? markers[0].t - 0.05 : ref);
  let m = Math.max(0, Math.round((ref - target) / barT));
  while (m > 0 && ref - m * barT < -1e-6) m--;
  const bpm = clampBpm(60 / spq);
  return { anchors: [{ q: 0, t: ref - m * barT, manual: true }], bpm, loopBpm, fitted, ref };
}

// The straight line of beats (t = t0 + k·spb) that best fits the transients within `tol` of a beat of
// the current one, between a and b. Strong hits count more, as in beat tracking. Null with too few.
function fitBeats(markers: readonly Hit[], t0: number, spb: number, tol: number, a: number, b: number): { t0: number; spb: number; n: number; sd: number } | null {
  let sw = 0, sk = 0, st = 0, skk = 0, skt = 0, kMin = Infinity, kMax = -Infinity;
  const pts: { k: number; t: number }[] = [];
  for (const h of markers) {
    if (h.t < a || h.t > b) continue;
    const k = Math.round((h.t - t0) / spb);
    if (Math.abs(h.t - (t0 + k * spb)) > tol) continue;
    const w = 0.35 + 0.65 * (h.s == null ? 1 : h.s);
    sw += w; sk += w * k; st += w * h.t; skk += w * k * k; skt += w * k * h.t;
    kMin = Math.min(kMin, k); kMax = Math.max(kMax, k);
    pts.push({ k, t: h.t });
  }
  const den = sw * skk - sk * sk;
  if (pts.length < 8 || kMax - kMin < 8 || !(den > 0)) return null;
  const s = (sw * skt - sk * st) / den, c = (st - s * sk) / sw;
  if (!(s > 0)) return null;
  const res = pts.map((p) => Math.abs(p.t - (c + p.k * s))).sort((x, y) => x - y);
  return { t0: c, spb: s, n: pts.length, sd: 1.4826 * res[res.length >> 1] };
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
