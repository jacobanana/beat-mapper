import { type Algo, type Analysis, type Band, frameTime, localDiff, odfOf } from '../dsp/onset';
import { refineOnset, snapToZero } from '../dsp/refine';
import type { Candidate, Marker } from '../types';

/**
 * Every peak of a detection function that could be a transient, placed on the waveform and scored.
 * The settings (sensitivity, gap) pick among these later without re-running the analysis.
 */
export function pickCandidates(an: Analysis, band: Band, x: Float32Array, sr: number, algo: Algo = 'flux'): Candidate[] {
  const odf = odfOf(an, algo, band), fr = an.fr;
  const d = localDiff(odf, Math.max(2, Math.round(0.1 * fr))), m = Math.max(1, Math.round(0.016 * fr));
  const raw: { n: number; d: number }[] = [];
  for (let n = 1; n < odf.length - 1; n++) {
    if (d[n] <= 0) continue;
    let ok = true;
    const v = odf[n];
    for (let k = Math.max(0, n - m); k <= Math.min(odf.length - 1, n + m); k++) {
      if (odf[k] > v || (odf[k] === v && k < n)) { ok = false; break; }
    }
    if (ok) raw.push({ n, d: d[n] });
  }
  if (!raw.length) return [];
  const sorted = raw.map((r) => r.d).sort((a, b) => a - b);
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] || 1;
  const out: Candidate[] = [];
  for (const r of raw) {
    const s = Math.min(1, r.d / ref);
    if (s < 0.02) continue;
    out.push({ t: snapToZero(x, sr, refineOnset(x, sr, frameTime(an, r.n, sr))), s });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Sensitivity 0..100 to the strength threshold a candidate must reach. */
export function sensToThr(sens: number): number {
  return Math.pow(1 - sens / 100, 3);
}

/**
 * Which candidates the settings let through: above the threshold, and the strongest within each gap.
 * Returns candidate indices. Removed candidates still count here, so taking one out doesn't let a
 * weaker neighbour it was beating take its place.
 */
export function detectMarkers(cands: readonly Candidate[], thr: number, gap: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (c.s < thr) continue;
    const last = out.length ? cands[out[out.length - 1]] : undefined;
    if (last && c.t - last.t < gap) { if (c.s > last.s) out[out.length - 1] = i; }
    else out.push(i);
  }
  return out;
}

export interface ManualMarker {
  readonly id: number;
  readonly t: number;
}

/** The markers shown: the detected ones minus the removed, plus the ones placed by hand. */
export function filterMarkers(
  cands: readonly Candidate[],
  detected: readonly number[],
  removed: ReadonlySet<number>,
  manual: readonly ManualMarker[],
): Marker[] {
  const out: Marker[] = [];
  for (const i of detected) if (!removed.has(i)) out.push({ t: cands[i].t, s: cands[i].s, manual: false, id: 'c' + i });
  if (!manual.length) return out;
  const res = out
    .filter((c) => !manual.some((m) => Math.abs(m.t - c.t) < 0.005))
    .concat(manual.map((m) => ({ t: m.t, s: 1, manual: true, id: 'm' + m.id })));
  res.sort((a, b) => a.t - b.t);
  return res;
}

/**
 * Candidate indices for a list of removed times, each matched to the closest candidate within
 * `tol` seconds. This is how removals survive a round trip through a session file.
 */
export function matchRemoved(cands: readonly Candidate[], times: readonly number[], tol = 0.008): number[] {
  const out = new Set<number>();
  for (const t of times) {
    let best = -1;
    let lo = 0, hi = cands.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cands[m].t < t - tol) lo = m + 1; else hi = m; }
    for (let i = lo; i < cands.length && cands[i].t <= t + tol; i++) {
      if (best < 0 || Math.abs(cands[i].t - t) < Math.abs(cands[best].t - t)) best = i;
    }
    if (best >= 0) out.add(best);
  }
  return [...out].sort((a, b) => a - b);
}
