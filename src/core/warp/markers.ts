// Warp markers: a transient put on a grid line by hand. The pins of the tempo map line up the beats;
// a warp marker lines up one hit inside a beat, so the warp moves that hit exactly onto its grid line
// and stretches the audio either side to fit. They are laid over the pins to make the map the warp
// follows, which leaves the tempo map of the Beats step as it is.
import type { Grid } from '../tempo/meter';
import { type PositionMap, TempoMap } from '../tempo/tempo-map';
import type { Anchor, TimeRange } from '../types';

/** The audio at time t (a transient, seconds) goes to musical position q (quarter notes from bar 1). */
export interface WarpMarker {
  readonly t: number;
  readonly q: number;
}

const EPS_T = 1e-4, EPS_Q = 1e-6;
/** Seconds beyond the pins where the far ends of a warp's map are held: past any audio. */
const FAR = 1e5;

/** Two points that can both be on a monotone map: one is later in time and in position. */
const inOrder = (a: { t: number; q: number }, b: { t: number; q: number }) =>
  (b.t > a.t + EPS_T && b.q > a.q + EPS_Q) || (b.t < a.t - EPS_T && b.q < a.q - EPS_Q);

/**
 * Where the warp puts each moment of the audio: the pins, with the warp markers laid over them. It
 * answers positions only. It is not a tempo, so it has no bars, beats or BPM to give: those are the
 * tempo map's, which warp markers leave as it is.
 */
export class Alignment implements PositionMap {
  private constructor(private readonly map: TempoMap, readonly moved: boolean) {}

  /**
   * The pins with the markers laid over. A pin that a warp marker contradicts (the same position
   * elsewhere, or out of order with it) gives way, since the marker is the later and finer decision.
   */
  static of(map: TempoMap, markers: readonly WarpMarker[]): Alignment {
    if (!markers.length || map.isEmpty) return new Alignment(map, false);
    const pins = map.anchors.filter((p) => markers.every((w) => inOrder(w, p)));
    // Past the first and last points a map carries on at the slope of its end segments. A marker near an
    // end would tilt that slope and stretch the whole lead-in or tail, so two far points on the pins' own
    // map keep the ends going as the pins had them.
    const A = map.anchors, far = (t: number) => ({ q: map.timeToPos(t), t, manual: false });
    const ends = [far(A[0].t - FAR), far(A[A.length - 1].t + FAR)];
    return new Alignment(new TempoMap([ends[0], ...pins, ...markers.map((w) => ({ q: w.q, t: w.t, manual: true })), ends[1]], map.baseBpm), true);
  }

  get isEmpty(): boolean { return this.map.isEmpty; }
  get anchors(): readonly Anchor[] { return this.map.anchors; }
  /** Where the audio that goes to position q is. */
  posToTime(q: number): number { return this.map.posToTime(q); }
  /** The position the audio at time t goes to. */
  timeToPos(t: number): number { return this.map.timeToPos(t); }
}

export type PlaceResult = { ok: true; markers: WarpMarker[] } | { ok: false; reason: 'crosses' };

/**
 * Puts the audio at t on position q. A marker already at t, or already on q, is replaced; one it would
 * cross (earlier in time but later on the grid, or the other way round) makes it fail.
 */
export function placeWarpMarker(markers: readonly WarpMarker[], t: number, q: number): PlaceResult {
  const rest = markers.filter((w) => Math.abs(w.t - t) > EPS_T && Math.abs(w.q - q) > EPS_Q);
  const m = { t, q };
  if (!rest.every((w) => inOrder(m, w))) return { ok: false, reason: 'crosses' };
  return { ok: true, markers: [...rest, m].sort((a, b) => a.t - b.t) };
}

/** Removes the marker at t, if there is one. */
export function removeWarpMarker(markers: readonly WarpMarker[], t: number): WarpMarker[] | null {
  const out = markers.filter((w) => Math.abs(w.t - t) > EPS_T);
  return out.length === markers.length ? null : out;
}

/** The marker at t, if there is one. */
export const warpMarkerAt = (markers: readonly WarpMarker[], t: number): WarpMarker | undefined =>
  markers.find((w) => Math.abs(w.t - t) <= EPS_T);

/**
 * Quantize: every transient in the range onto the grid line nearest to it on `map`. Where two
 * transients reach for the same line, the closer one takes it and the other is left to move with the
 * audio around it (a flam, a ghost note). The markers already placed stay, and a transient that would
 * cross one is left alone. `strength` (0..1) moves each transient only that part of the way to its
 * line, which tightens the timing and keeps some of the feel; at 0 nothing moves, so nothing is added.
 */
export function quantizeTransients(
  map: PositionMap,
  grid: Grid,
  transients: readonly number[],
  range: TimeRange,
  markers: readonly WarpMarker[],
  strength = 1,
): WarpMarker[] {
  const s = Math.max(0, Math.min(1, strength));
  if (map.isEmpty || s === 0) return [...markers];
  const picked: { t: number; q: number; d: number }[] = [];
  for (const t of transients) {
    if (t < range.a || t > range.b || warpMarkerAt(markers, t)) continue;
    const q = grid.nearest(map.timeToPos(t)), d = Math.abs(map.posToTime(q) - t), last = picked[picked.length - 1];
    if (last && Math.abs(last.q - q) < EPS_Q) { if (d < last.d) picked[picked.length - 1] = { t, q, d }; }
    else picked.push({ t, q, d });
  }
  // Part of the way from where the transient sits on the map to its line.
  const added = picked.map(({ t, q }) => ({ t, q: q + (1 - s) * (map.timeToPos(t) - q) })).filter((p) => markers.every((w) => inOrder(w, p)));
  return [...markers, ...added].sort((a, b) => a.t - b.t);
}
