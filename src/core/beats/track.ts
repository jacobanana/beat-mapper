import { lowerBound } from '../search';
import type { Anchor } from '../types';

/** A transient as the beat tracker sees it: a time and, optionally, how strong it is (0..1). */
export interface Hit {
  readonly t: number;
  readonly s?: number | null;
}

export interface TrackOptions {
  /** Distance between the beats to follow, in quarter notes (a beat or a bar). */
  stepQ: number;
  /** Length of a beat of the meter in quarter notes. */
  beatQ: number;
  /** Search window around each predicted beat, as a fraction of a beat. */
  tolFrac: number;
  /** End of the audio; forward tracking stops there. */
  dur: number;
  /** Backward tracking stops before this time. */
  stopT?: number;
}

export interface TrackedBeat {
  readonly q: number;
  readonly t: number;
  /** Landed on a transient, as opposed to predicted across a gap. */
  readonly matched: boolean;
}

const weight = (m: Hit) => 0.35 + 0.65 * (m.s == null ? 1 : m.s);

function bestMarker(markers: readonly Hit[], pred: number, tol: number, after: number, before: number): Hit | null {
  let best: Hit | null = null, bs = 0;
  for (let i = lowerBound(markers, pred - tol); i < markers.length && markers[i].t <= pred + tol; i++) {
    const m = markers[i];
    if (m.t <= after || m.t >= before) continue;
    const sc = weight(m) * (1 - (0.8 * Math.abs(m.t - pred)) / tol);
    if (sc > bs) { bs = sc; best = m; }
  }
  return best;
}

/**
 * Follows the beat outward from a known point. The tracker keeps its own smoothed phase and period,
 * so one off-beat hit can't drag it away; pins still land exactly on the transient that was chosen.
 */
export function trackBeats(markers: readonly Hit[], q0: number, t0: number, per0: number, dir: 1 | -1, o: TrackOptions): TrackedBeat[] {
  const out: TrackedBeat[] = [], step = o.stepQ, eps = 1e-6;
  let per = per0, pq = q0, ph = t0, lastPin = t0, errAvg = -1;
  let k = dir > 0 ? Math.floor(q0 / step + eps) + 1 : Math.ceil(q0 / step - eps) - 1;
  for (let n = 0; n < 200000; n++, k += dir) {
    const q = k * step, pred = ph + (q - pq) * per;
    if (dir > 0 ? pred >= o.dur : pred < (o.stopT || 0)) break;
    const tol = o.tolFrac * o.beatQ * per;
    if (errAvg < 0) errAvg = tol * 0.3;
    const sig = Math.max(0.012, Math.min(tol * 0.5, 2.5 * errAvg));
    let best: Hit | null = null, bs = 0.1;
    for (let i = lowerBound(markers, pred - tol); i < markers.length && markers[i].t <= pred + tol; i++) {
      const m = markers[i];
      if (dir > 0 ? m.t <= lastPin + 0.01 : m.t >= lastPin - 0.01) continue;
      const d = m.t - pred, nx = m.t + dir * step * per, j = lowerBound(markers, nx - sig);
      const support = j < markers.length && markers[j].t <= nx + sig ? 1.5 : 1;
      const sc = weight(m) * Math.exp((-0.5 * d * d) / (sig * sig)) * support;
      if (sc > bs) { bs = sc; best = m; }
    }
    if (best) {
      const e = best.t - pred;
      errAvg = 0.7 * errAvg + 0.3 * Math.abs(e);
      per += (0.2 * e) / (q - pq);
      per = Math.max(per0 * 0.7, Math.min(per0 * 1.4, per));
      ph = pred + 0.7 * e;
      lastPin = best.t;
      out.push({ q, t: best.t, matched: true });
    } else {
      ph = pred;
      errAvg = Math.min(tol * 0.3, errAvg * 1.25);
      out.push({ q, t: pred, matched: false });
    }
    pq = q;
  }
  return out;
}

export interface AutoMapOptions extends TrackOptions {
  /** Seconds per quarter note to follow after a lone pin. */
  spq: number;
}

/**
 * Beat tracking constrained by the user's pins: between two pins every step is placed on the best
 * transient along the line joining them, and after the last pin the tracker follows the music.
 */
export function autoMap(manual: readonly Pick<Anchor, 'q' | 't'>[], markers: readonly Hit[], o: AutoMapOptions): Anchor[] {
  const M = manual.slice().sort((a, b) => a.q - b.q);
  const out: Anchor[] = M.map((a) => ({ q: a.q, t: a.t, manual: true }));
  const step = o.stepQ, eps = 1e-6;
  for (let s = 0; s < M.length - 1; s++) {
    const A = M[s], B = M[s + 1];
    let pq = A.q, pt = A.t;
    for (let k = Math.floor(A.q / step + eps) + 1; k * step < B.q - eps; k++) {
      const q = k * step, slope = (B.t - pt) / (B.q - pq), pred = pt + (q - pq) * slope;
      const m = bestMarker(markers, pred, o.tolFrac * o.beatQ * slope, pt + 0.01, B.t - 0.01);
      if (m) { out.push({ q, t: m.t, manual: false }); pq = q; pt = m.t; }
    }
  }
  const L = M[M.length - 1];
  let per = o.spq;
  if (M.length > 1) { const P = M[M.length - 2]; per = (L.t - P.t) / (L.q - P.q); }
  for (const p of trackBeats(markers, L.q, L.t, per, 1, o)) if (p.matched) out.push({ q: p.q, t: p.t, manual: false });
  out.sort((a, b) => a.q - b.q);
  return out;
}
