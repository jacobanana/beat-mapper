// SuperFlux (Böck & Widmer, "Maximum filter vibrato suppression for onset detection", DAFx 2013), and
// what goes with it to find onsets in pitched, sustained music as well as in drums.
//
// Plain spectral flux compares each bin with the frame 6 ms before it. A held piano note is two or
// three strings a cent or so apart, so every partial swells and dips a few times a second, and on a
// chord those small rises add up across dozens of partials into peaks as tall as a soft note. Here the
// spectrum is read in bands a quarter tone wide, and each band is compared with the loudest of it and
// its neighbours 15 ms before, so a partial that wobbles in level or pitch never looks new.
//
// Peaks are then picked against the detection function's own mean around them (Böck, Krebs & Schedl,
// ISMIR 2012), not scaled against the loudest peaks of the take: on a sparse piano part the loudest
// peaks are few, and a scale set by them lets every wobble through. And a peak can be asked whether the
// spectrum once the window has passed it holds more than it did before (`lasting`): a new note stays,
// as the onsets gate the frames in Onsets and Frames (Hawthorne et al., ISMIR 2018), while the thump
// of a damper or a string's swell does not. See docs/transients.md for what each of these is worth.
import { makeFFT } from './fft';
import { peakOf } from './peaks';

export interface BandOptions {
  /** FFT size, a power of two. */
  N: number;
  fmin?: number;
  fmax?: number;
  /**
   * Bands per octave; where the FFT's bins are wider than that (under about 700 Hz at 44.1 kHz with
   * N = 2048), a band is one bin. 0: every bin is its own band.
   */
  bpo?: number;
  /** The amplitude of the loudest partial the audio can have: levels are compressed against it. */
  ref: number;
}

/** Reads the spectrum at any instant as log-compressed bands. */
export class BandFrames {
  readonly K: number;
  /** Centre frequency of each band, Hz. */
  readonly hz: Float32Array;
  readonly N: number;
  private readonly first: Int32Array;
  private readonly last: Int32Array;
  private readonly fft: (re: Float64Array, im: Float64Array) => void;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly win: Float64Array;
  private gain = 1;

  constructor(sr: number, o: BandOptions) {
    const { N } = o, fmin = o.fmin ?? 30, fmax = Math.min(o.fmax ?? 16000, 0.45 * sr), bpo = o.bpo ?? 24;
    this.N = N;
    // Each bin goes to the nearest band; bands left without a bin (where bins are wider than bands) go.
    const first: number[] = [], last: number[] = [], hz: number[] = [];
    let prev = -1;
    for (let b = 1; b < N / 2; b++) {
      const f = (b * sr) / N;
      if (f < fmin || f > fmax) continue;
      const k = bpo > 0 ? Math.round(bpo * Math.log2(f / fmin)) : b;
      if (k !== prev) { first.push(b); last.push(b); hz.push(bpo > 0 ? fmin * Math.pow(2, k / bpo) : f); prev = k; }
      else last[last.length - 1] = b;
    }
    this.K = first.length;
    this.first = Int32Array.from(first);
    this.last = Int32Array.from(last);
    this.hz = Float32Array.from(hz);
    this.fft = makeFFT(N);
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    this.setRef(o.ref);
  }

  /** Compress against this amplitude from now on (see `BandOptions.ref`). */
  setRef(ref: number): void {
    // A steady partial of amplitude A sums to about 2A over its bins; the loudest possible one reads
    // log10(1001) = 3, and one 60 dB under it still reads 0.3.
    this.gain = 1000 / (2 * Math.max(1e-9, ref));
  }

  /**
   * The loudest any bin gets in frames centred every `hop` samples from c0, as a steady partial's
   * amplitude: for compressing against the loudest partial rather than the loudest sample.
   */
  loudestBin(x: Float32Array, c0: number, hop: number, frames: number): number {
    let m = 0;
    for (let n = 0; n < frames; n++) {
      this.transform(x, c0 + n * hop);
      for (let b = 1; b < this.N / 2; b++) { const v = this.re[b] * this.re[b] + this.im[b] * this.im[b]; if (v > m) m = v; }
    }
    return (Math.sqrt(m) * 4) / this.N;
  }

  /** The frame whose window is centred on sample c: each band's level into S, from index o. */
  read(x: Float32Array, c: number, S: Float32Array, o = 0): void {
    const { re, im } = this, sc = 4 / this.N;
    this.transform(x, c);
    for (let k = 0; k < this.K; k++) {
      let s = 0;
      for (let b = this.first[k], z = this.last[k]; b <= z; b++) s += Math.hypot(re[b], im[b]) * sc;
      S[o + k] = Math.log10(1 + this.gain * s);
    }
  }

  private transform(x: Float32Array, c: number): void {
    const { N, re, im, win } = this, off = Math.round(c) - N / 2;
    for (let i = 0; i < N; i++) {
      const s = off + i;
      re[i] = (s >= 0 && s < x.length ? x[s] : 0) * win[i];
      im[i] = 0;
    }
    this.fft(re, im);
  }
}

export interface SuperFluxOptions {
  /** Hop between frames, samples, and the sample the first frame's window is centred on. */
  hop: number;
  c0: number;
  frames: number;
  /** Each band is compared with the loudest of it and `spread` bands either side, `lag` frames before. */
  lag: number;
  spread?: number;
  /** Frequency ranges to sum separately, Hz, by name; the whole spectrum when missing. */
  ranges?: Record<string, readonly [number, number]>;
  onProgress?: (fraction: number) => void;
  yieldToEventLoop?: boolean;
}

/** The SuperFlux detection function of x, one value a frame, summed over each range of bands. */
export async function superflux(x: Float32Array, bf: BandFrames, o: SuperFluxOptions): Promise<Record<string, Float32Array>> {
  const run = frames(x, bf, o);
  for (let r = run.next(); ; r = run.next()) {
    if (r.done) return r.value;
    o.onProgress?.(r.value);
    if (o.yieldToEventLoop) await new Promise((res) => setTimeout(res, 0));
  }
}

/** The same, all at once. */
export function superfluxNow(x: Float32Array, bf: BandFrames, o: SuperFluxOptions): Record<string, Float32Array> {
  const run = frames(x, bf, o);
  for (let r = run.next(); ; r = run.next()) if (r.done) return r.value;
}

// The work, pausing every 2048 frames with how far it has got.
function* frames(x: Float32Array, bf: BandFrames, o: SuperFluxOptions): Generator<number, Record<string, Float32Array>> {
  const { hop, c0, frames: F, lag } = o, K = bf.K, spread = o.spread ?? 1, R = lag + 1;
  const ranges = o.ranges ?? { full: [0, Infinity] as const }, names = Object.keys(ranges);
  const out: Record<string, Float32Array> = {};
  for (const n of names) out[n] = new Float32Array(F);
  const inRange = names.map((n) => Uint8Array.from(bf.hz, (f) => (f >= ranges[n][0] && f < ranges[n][1] ? 1 : 0)));
  // The last lag+1 frames of levels, the current one among them.
  const S = new Float32Array(R * K), ref = new Float32Array(K), sums = new Float64Array(names.length);
  for (let n = 0; n < F; n++) {
    const cur = (n % R) * K;
    bf.read(x, c0 + n * hop, S, cur);
    sums.fill(0);
    if (n >= lag) {
      const old = ((n - lag) % R) * K;
      for (let k = 0; k < K; k++) {
        let m = 0;
        for (let j = Math.max(0, k - spread); j <= Math.min(K - 1, k + spread); j++) if (S[old + j] > m) m = S[old + j];
        ref[k] = m;
      }
      for (let k = 0; k < K; k++) {
        const d = S[cur + k] - ref[k];
        if (d > 0) for (let r = 0; r < names.length; r++) if (inRange[r][k]) sums[r] += d;
      }
    }
    for (let r = 0; r < names.length; r++) out[names[r]][n] = sums[r];
    if ((n & 2047) === 0) yield n / F;
  }
  return out;
}

export interface Peak {
  /** Frame. */
  n: number;
  /** How far the peak stands over the mean around it. */
  d: number;
}

export interface PeakOptions {
  /** The peak is the highest from `preMax` frames before it to `postMax` after. */
  preMax: number;
  postMax: number;
  /** It is measured against the mean from `preAvg` frames before it to `postAvg` after. */
  preAvg: number;
  postAvg: number;
}

/** The peaks of a detection function and how far each stands over the mean around it (Böck, Krebs & Schedl 2012). */
export function pickPeaks(odf: ArrayLike<number>, o: PeakOptions): Peak[] {
  const F = odf.length, ps = new Float64Array(F + 1), out: Peak[] = [];
  for (let i = 0; i < F; i++) ps[i + 1] = ps[i] + odf[i];
  for (let n = 0; n < F; n++) {
    const v = odf[n];
    if (!(v > 0)) continue;
    let top = true;
    for (let j = Math.max(0, n - o.preMax); top && j <= Math.min(F - 1, n + o.postMax); j++) if (odf[j] > v || (odf[j] === v && j < n)) top = false;
    if (!top) continue;
    const a = Math.max(0, n - o.preAvg), b = Math.min(F, n + o.postAvg + 1), d = v - (ps[b] - ps[a]) / (b - a);
    if (d > 0) out.push({ n, d });
  }
  return out;
}

/**
 * How much more the spectrum holds just after time t than just before it: each band's level in a
 * window that has wholly passed t against the loudest of it and its neighbours in one wholly before t
 * (gap seconds clear of t either side), rises only, summed over the bands in `range` (Hz). A note or a
 * hit that starts at t is still there; a swell, a wobble or a thump has gone or was there already.
 */
export function lasting(x: Float32Array, sr: number, bf: BandFrames, t: number, gap = 0.005, range: readonly [number, number] = [0, Infinity]): number {
  const K = bf.K, half = bf.N / 2, g = Math.round(gap * sr), c = Math.round(t * sr);
  const pre = new Float32Array(K), post = new Float32Array(K);
  bf.read(x, c - half - g, pre);
  bf.read(x, c + half + g, post);
  let s = 0;
  for (let k = 0; k < K; k++) {
    if (bf.hz[k] < range[0] || bf.hz[k] >= range[1]) continue;
    const m = Math.max(pre[k], k > 0 ? pre[k - 1] : 0, k + 1 < K ? pre[k + 1] : 0), d = post[k] - m;
    if (d > 0) s += d;
  }
  return s;
}

export interface OnsetOptions {
  /** FFT size; frames every `hop` seconds, each band against the loudest near it `lag` seconds before. */
  N: number;
  hop: number;
  lag: number;
  fmin?: number;
  bpo?: number;
  /** Levels compressed against the take's loudest partial (true), or its loudest sample. */
  byPartial?: boolean;
  /**
   * A peak is the highest within `peakWindow` seconds either side, measured against the mean from
   * `meanWindow` before it to `peakWindow` after, and stands over that mean by `threshold` of the
   * take's highest.
   */
  peakWindow: number;
  meanWindow: number;
  threshold: number;
  /** Measure what lasts after each onset. */
  lasting?: boolean;
}

export interface Onset {
  t: number;
  /** How far the peak stands over the mean around it, against the take's highest. */
  d: number;
  /** What lasts after it (`lasting`), when asked for; else 0. */
  lasting: number;
}

/** The onsets of a whole signal, frames centred every hop from its start: for the note detectors. */
export function onsetsOf(y: Float32Array, sr: number, o: OnsetOptions): Onset[] {
  const hop = Math.max(1, Math.round(o.hop * sr)), F = Math.ceil(y.length / hop), fr = sr / hop;
  const bf = new BandFrames(sr, { N: o.N, fmin: o.fmin ?? 60, fmax: 0.5 * sr, bpo: o.bpo ?? 24, ref: peakOf(y) });
  // A partial spreads over about two bins, of which a band one bin wide reads the one.
  if (o.byPartial) bf.setRef(bf.loudestBin(y, 0, hop, F) / (o.bpo === 0 ? 2 : 1));
  const nov = superfluxNow(y, bf, { hop, c0: 0, frames: F, lag: Math.max(1, Math.round(o.lag * fr)) }).full;
  let top = 0;
  for (let f = 0; f < F; f++) if (nov[f] > top) top = nov[f];
  const W = Math.round(o.peakWindow * fr), M = Math.round(o.meanWindow * fr);
  return pickPeaks(nov, { preMax: W, postMax: W, preAvg: M, postAvg: W })
    .filter((q) => q.d >= o.threshold * top)
    .map((q) => { const t = (q.n * hop) / sr; return { t, d: q.d / (top || 1), lasting: o.lasting ? lasting(y, sr, bf, t, 0.01) : 0 }; });
}
