import { makeFFT } from './fft';

export const ALGOS = ['flux', 'complex', 'gdelay', 'energy'] as const;
export type Algo = (typeof ALGOS)[number];
export const BANDS = ['full', 'low', 'high'] as const;
export type Band = (typeof BANDS)[number];

export type BandSet = Record<Band, Float32Array>;

/** The output of one analysis pass: every onset detection function, in every band. */
export interface Analysis {
  readonly odfs: Record<Algo, BandSet>;
  /** Frame rate of the detection functions, frames per second. */
  readonly fr: number;
  readonly N: number;
  readonly hop: number;
  readonly pad: number;
  readonly frames: number;
}

export interface AnalyzeOptions {
  /** Called now and then with progress 0..1. */
  onProgress?: (fraction: number) => void;
  /** Give the event loop a turn after each progress report, so a page stays responsive. */
  yieldToEventLoop?: boolean;
}

// Onset detection functions: four of them from one pass of FFTs, each in three bands (everything,
// below 250 Hz, above 3 kHz), at frame rate sr/hop. Frame n's value sits at (n*hop-pad+0.6N)/sr.
//   flux:    spectral flux. The rise in log magnitude since the previous frame, summed over bins.
//   complex: rectified complex-domain difference (Duxbury, Bello et al. 2003; Dixon 2006). Each bin
//            is predicted from the previous two frames (same magnitude, phase advancing steadily)
//            and the distance to what was observed is counted where the magnitude rose. Catches
//            soft, pitched onsets that barely change loudness.
//   gdelay:  group delay (Van Belle 2012). A bin's phase slope across frequency says where inside
//            the window its energy sits, so each bin votes for that instant, weighted by its log
//            magnitude. A tick collects every vote at one instant; a steady tone votes for the
//            window centre, which slides along and blurs into a floor.
//   energy:  the rise in log energy since the previous frame. The plain loudness jump.
export async function analyze(x: Float32Array, sr: number, opts: AnalyzeOptions = {}): Promise<Analysis> {
  const { onProgress, yieldToEventLoop = true } = opts;
  const N = sr > 60000 ? 2048 : 1024, hop = N >> 2, pad = N, half = N >> 1;
  const frames = Math.max(1, Math.floor((x.length + pad - N) / hop) + 1);
  const mk = (): BandSet => ({ full: new Float32Array(frames), low: new Float32Array(frames), high: new Float32Array(frames) });
  const odfs: Record<Algo, BandSet> = { flux: mk(), complex: mk(), gdelay: mk(), energy: mk() };
  const G = odfs.gdelay, E = odfs.energy;
  const fft = makeFFT(N), re = new Float64Array(N), im = new Float64Array(N), win = new Float64Array(N);
  const prev = new Float32Array(half), ph1 = new Float32Array(half), ph2 = new Float32Array(half);
  let e1 = 0, e1l = 0, e1h = 0;
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const bLow = Math.ceil(250 / (sr / N)), bHigh = Math.floor(3000 / (sr / N));
  const sc = (4 / N) * 200, TAU = 2 * Math.PI, gOff = pad - 0.6 * N, eps = 1e-9 * N * N;
  for (let n = 0; n < frames; n++) {
    const off = n * hop - pad;
    for (let i = 0; i < N; i++) {
      const s = off + i;
      re[i] = (s >= 0 && s < x.length ? x[s] : 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let f = 0, fl = 0, fh = 0, c = 0, cl = 0, ch = 0, e = 0, el = 0, eh = 0;
    let pp = Math.atan2(im[0], re[0]);
    for (let b = 1; b < half; b++) {
      const r = re[b], q = im[b], m2 = r * r + q * q, L = Math.log1p(Math.sqrt(m2) * sc), phase = Math.atan2(q, r);
      const band = b < bLow ? 1 : b >= bHigh ? 2 : 0, d = L - prev[b];
      if (d > 0) {
        f += d; if (band === 1) fl += d; else if (band === 2) fh += d;
        const pr = prev[b];
        const cd = Math.sqrt(Math.max(0, L * L + pr * pr - 2 * L * pr * Math.cos(phase - 2 * ph1[b] + ph2[b])));
        c += cd; if (band === 1) cl += cd; else if (band === 2) ch += cd;
      }
      // Phase step to the previous bin, unwrapped into (-2pi, 0]: a tick at sample p of the window has
      // phase -2pi*k*p/N, so the step is -2pi*p/N and p = -step*N/2pi.
      let dp = phase - pp; pp = phase;
      while (dp > 0) dp -= TAU;
      while (dp <= -TAU) dp += TAU;
      const gi = Math.round((off - (dp / TAU) * N + gOff) / hop);
      if (gi >= 0 && gi < frames) { G.full[gi] += L; if (band === 1) G.low[gi] += L; else if (band === 2) G.high[gi] += L; }
      e += m2; if (band === 1) el += m2; else if (band === 2) eh += m2;
      prev[b] = L; ph2[b] = ph1[b]; ph1[b] = phase;
    }
    odfs.flux.full[n] = f; odfs.flux.low[n] = fl; odfs.flux.high[n] = fh;
    odfs.complex.full[n] = c; odfs.complex.low[n] = cl; odfs.complex.high[n] = ch;
    E.full[n] = Math.max(0, Math.log(e + eps) - Math.log(e1 + eps));
    E.low[n] = Math.max(0, Math.log(el + eps) - Math.log(e1l + eps));
    E.high[n] = Math.max(0, Math.log(eh + eps) - Math.log(e1h + eps));
    e1 = e; e1l = el; e1h = eh;
    if ((n & 2047) === 0 && onProgress) {
      onProgress(n / frames);
      if (yieldToEventLoop) await new Promise((r) => setTimeout(r, 0));
    }
  }
  // Group-delay votes land at sample precision from four overlapping windows; a 3-tap smoothing knits them.
  for (const k of BANDS) {
    const a = G[k], b = new Float32Array(frames);
    for (let n = 0; n < frames; n++) b[n] = (2 * a[n] + (n ? a[n - 1] : 0) + (n + 1 < frames ? a[n + 1] : 0)) / 4;
    G[k] = b;
  }
  return { odfs, fr: sr / hop, N, hop, pad, frames };
}

export function odfOf(an: Analysis, algo: Algo, band: Band): Float32Array {
  return an.odfs[algo][band];
}

/** Time in seconds of frame n of a detection function. */
export function frameTime(an: Analysis, n: number, sr: number): number {
  return (n * an.hop - an.pad + 0.6 * an.N) / sr;
}

const refCache = new WeakMap<Analysis, Map<string, number>>();
/** Level that counts as "full" for drawing a detection function: its 99th percentile. */
export function odfRef(an: Analysis, algo: Algo, band: Band): number {
  let cache = refCache.get(an);
  if (!cache) refCache.set(an, (cache = new Map()));
  const k = algo + '/' + band, hit = cache.get(k);
  if (hit !== undefined) return hit;
  const s = Float32Array.from(odfOf(an, algo, band)).sort();
  const r = s[Math.min(s.length - 1, Math.floor(s.length * 0.99))] || 1;
  cache.set(k, r);
  return r;
}

/** Each value minus the mean of the window of ±w around it. */
export function localDiff(odf: ArrayLike<number>, w: number): Float32Array {
  const n = odf.length, ps = new Float64Array(n + 1), d = new Float32Array(n);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + odf[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    d[i] = odf[i] - (ps[b] - ps[a]) / (b - a);
  }
  return d;
}
