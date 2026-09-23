import { makeFFT } from '../dsp/fft';

/** A magnitude spectrogram on a log-frequency axis: what the drum model reads. */
export interface Spectrogram {
  /** Magnitudes, frame after frame, `bands` values each. */
  readonly data: Float32Array;
  readonly frames: number;
  readonly bands: number;
  /** Centre frequency of each band, Hz. */
  readonly freqs: Float32Array;
  /** FFT bins summed into each band. */
  readonly widths: Uint16Array;
  /** Frames per second. Frame n is the window centred on n / fr seconds. */
  readonly fr: number;
  readonly N: number;
  readonly hop: number;
}

export interface SpectrogramOptions {
  bandsPerOctave?: number;
  fmin?: number;
  fmax?: number;
  /** Keep only the percussive part of each frame (median-filter HPSS), for a full mix. */
  percussive?: boolean;
  onProgress?: (fraction: number) => void;
  yieldToEventLoop?: boolean;
}

// Harmonic/percussive separation by median filtering (FitzGerald 2010). A sustained note is a line
// along time in the spectrogram and a hit is a line across frequency, so each bin's median over the
// frames around it follows the notes and its median over the bins around it follows the hits. Each
// bin keeps the share of its magnitude the hit median claims (a Wiener-style soft mask). It runs as the
// frames come, with only the last HPSS_T frames kept, so a whole song costs no more memory than a loop.
const HPSS_T = 17, HPSS_F = 17;

function median(a: Float64Array, n: number): number {
  const b = a.subarray(0, n).sort(), m = n >> 1;
  return n & 1 ? b[m] : (b[m - 1] + b[m]) / 2;
}

// A 23 ms window every 5.8 ms (at 44.1 or 48 kHz). Drums need the time resolution more than the
// frequency resolution: the lowest bands hold a single FFT bin each, which is enough to tell a kick's
// thump from a snare's body. A band's value is the sum of its bins' magnitudes, so the wide high
// bands, where hats and snare wires live, carry weight in proportion to how much spectrum they span.
export async function logSpectrogram(x: Float32Array, sr: number, o: SpectrogramOptions = {}): Promise<Spectrogram> {
  const { bandsPerOctave = 4, fmin = 30, fmax = 16000, percussive = false, onProgress, yieldToEventLoop = true } = o;
  const N = sr > 60000 ? 2048 : 1024, hop = N >> 2, half = N >> 1;
  const frames = Math.max(1, Math.ceil(x.length / hop));
  const top = Math.min(fmax, sr / 2);
  // Map bins to bands, dropping bands no bin falls in (the bottom octaves, where bins are wider than bands).
  const binBand = new Int16Array(half).fill(-1), raw = new Map<number, number>(), fsum: number[] = [], fcnt: number[] = [];
  for (let b = 1; b < half; b++) {
    const f = (b * sr) / N;
    if (f < fmin || f > top) continue;
    const r = Math.floor(Math.log2(f / fmin) * bandsPerOctave);
    let k = raw.get(r);
    if (k === undefined) { k = raw.size; raw.set(r, k); fsum.push(0); fcnt.push(0); }
    binBand[b] = k;
    fsum[k] += Math.log(f);
    fcnt[k]++;
  }
  const bands = raw.size, freqs = new Float32Array(bands), widths = Uint16Array.from(fcnt);
  for (let k = 0; k < bands; k++) freqs[k] = Math.exp(fsum[k] / fcnt[k]);

  const fft = makeFFT(N), re = new Float64Array(N), im = new Float64Array(N), win = new Float64Array(N);
  let wsum = 0;
  for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); wsum += win[i]; }
  const sc = 2 / wsum, data = new Float32Array(frames * bands);
  const ring = percussive ? new Float32Array(HPSS_T * half) : null, tmp = new Float64Array(Math.max(HPSS_T, HPSS_F));
  const lag = percussive ? HPSS_T >> 1 : 0, mag = new Float32Array(half);
  // Sums frame n's bins, given their magnitudes, into its bands.
  const toBands = (n: number, m: Float32Array) => {
    const row = n * bands;
    for (let b = 1; b < half; b++) { const k = binBand[b]; if (k >= 0) data[row + k] += m[b]; }
  };
  const separate = (n: number) => {
    const r = ring!, cur = r.subarray((n % HPSS_T) * half, (n % HPSS_T + 1) * half), m = mag, nt = Math.min(HPSS_T, frames);
    for (let b = 1; b < half; b++) {
      for (let j = 0; j < nt; j++) tmp[j] = r[j * half + b];
      const H = median(tmp, nt);
      let c = 0;
      for (let q = Math.max(1, b - (HPSS_F >> 1)); q <= Math.min(half - 1, b + (HPSS_F >> 1)); q++) tmp[c++] = cur[q];
      const P = median(tmp, c), v = cur[b];
      m[b] = (v * P * P) / (P * P + H * H + 1e-20);
    }
    toBands(n, m);
  };
  for (let n = 0; n < frames + lag; n++) {
    if (n < frames) {
      const off = n * hop - half;
      for (let i = 0; i < N; i++) {
        const s = off + i;
        re[i] = (s >= 0 && s < x.length ? x[s] : 0) * win[i];
        im[i] = 0;
      }
      fft(re, im);
      const dst = ring ? ring.subarray((n % HPSS_T) * half, (n % HPSS_T + 1) * half) : mag;
      for (let b = 1; b < half; b++) dst[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]) * sc;
      if (!ring) toBands(n, mag);
    } else if (ring) {
      // Past the end: the missing frames are silence.
      ring.fill(0, (n % HPSS_T) * half, (n % HPSS_T + 1) * half);
    }
    if (ring && n - lag >= 0) separate(n - lag);
    if ((n & 2047) === 0 && onProgress) {
      onProgress(Math.min(1, n / frames));
      if (yieldToEventLoop) await new Promise((r) => setTimeout(r, 0));
    }
  }
  return { data, frames, bands, freqs, widths, fr: sr / hop, N, hop };
}
