import { localDiff } from './onset';

/**
 * A starting tempo from a detection function: autocorrelation of its positive local deviations over
 * 48..220 BPM, weighted towards ~115 BPM, with the double-period lag lending support.
 */
export function estimateTempo(odf: ArrayLike<number>, fr: number): number {
  const d = localDiff(odf, Math.max(2, Math.round(0.1 * fr))), n = Math.min(d.length, 120000);
  const start = Math.max(0, Math.floor((d.length - n) / 2));
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.max(0, d[start + i]);
  const lo = Math.floor((fr * 60) / 220), hi = Math.min(n - 2, Math.ceil((fr * 60) / 48));
  if (hi <= lo + 2) return 120;
  const ac = new Float64Array(hi + 2);
  for (let lag = lo - 1; lag <= hi + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += v[i] * v[i + lag];
    ac[lag] = s / (n - lag);
  }
  let best = lo, bs = -1;
  for (let lag = lo; lag <= hi; lag++) {
    const bpm = (60 * fr) / lag, pr = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.8, 2));
    const dbl = 2 * lag <= hi + 1 ? ac[2 * lag] * 0.5 : 0, sc = (ac[lag] + dbl) * pr;
    if (sc > bs) { bs = sc; best = lag; }
  }
  const y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1], den = y0 - 2 * y1 + y2, sh = den ? (0.5 * (y0 - y2)) / den : 0;
  return (60 * fr) / (best + Math.max(-0.5, Math.min(0.5, sh)));
}
