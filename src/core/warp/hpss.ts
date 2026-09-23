// Harmonic-percussive separation by median filtering (Fitzgerald, DAFx 2010), for stretching a full
// mix as Driedger, Müller & Ewert do (IEEE Signal Processing Letters, 2014): the harmonic part goes
// through the phase vocoder, which keeps it in tune but smears attacks, and the percussive part
// through overlap-add with short frames, which keeps attacks sharp but would beat on a held note.
// Each does only what it is good at, and the two are added back.
//
// In a spectrogram a held note is a horizontal line and a hit a vertical one. A median along time
// keeps the lines and drops the hits; a median along frequency does the opposite. Each bin is shared
// between the two by how much of it each median kept (a soft mask), so they add back to the input.
import { makeFFT } from '../dsp/fft';
import { type Progress, addFrame, forwardPair, inversePair, newPair, readFrame, sqrtHann } from './frames';

export interface HpssOptions {
  /** FFT size, a power of two. */
  N: number;
  /** Median lengths: frames along time, bins along frequency. Odd. */
  timeLen?: number;
  freqLen?: number;
}

export interface Separated {
  harmonic: Float32Array[];
  percussive: Float32Array[];
}

export function hpss(chans: readonly Float32Array[], o: HpssOptions, onProgress?: Progress): Separated {
  const { N } = o, L = o.timeLen ?? 17, V = o.freqLen ?? 17, hl = L >> 1, vl = V >> 1;
  const H = N / 2, half = N / 2, B = N / 2 + 1, win = sqrtHann(N), fft = makeFFT(N);
  const len = chans[0].length, C = chans.length, G = Math.ceil(C / 2);
  const harmonic = chans.map(() => new Float32Array(len));
  // Frames are held in rings of L, so the median along time can look half a window ahead. Channels go
  // in pairs through one FFT each, and the mix's magnitudes come from their sum.
  const F = Math.ceil(len / H) + 2;
  const mags = Array.from({ length: L }, () => new Float32Array(B));
  const specs = Array.from({ length: L }, () => Array.from({ length: G }, () => newPair(B)));
  const re = new Float64Array(N), im = new Float64Array(N), fa = new Float64Array(N), fb = new Float64Array(N);
  const col = new Float64Array(Math.max(L, V)), hMed = new Float64Array(B), mask = new Float64Array(B), Y = newPair(B);
  const sumR = new Float64Array(B), sumI = new Float64Array(B);
  const start = (k: number) => (k - 1) * H - half;

  for (let k = 0; k < F + hl; k++) {
    if (k < F) {
      const r = k % L, m = mags[r];
      sumR.fill(0); sumI.fill(0);
      for (let g = 0; g < G; g++) {
        const a = chans[2 * g], b = chans[2 * g + 1], P = specs[r][g];
        readFrame(a, start(k), win, fa);
        if (b) readFrame(b, start(k), win, fb);
        forwardPair(fft, fa, b ? fb : null, re, im, P);
        for (let f = 0; f < B; f++) { sumR[f] += P.ar[f] + P.br[f]; sumI[f] += P.ai[f] + P.bi[f]; }
      }
      for (let f = 0; f < B; f++) m[f] = Math.hypot(sumR[f], sumI[f]);
    }
    const j = k - hl;
    if (j < 0) continue;
    const r = j % L, m = mags[r];
    const lo = Math.max(0, j - hl), hi = Math.min(F - 1, j + hl);
    for (let b = 0; b < B; b++) {
      let n = 0;
      for (let t = lo; t <= hi; t++) col[n++] = mags[t % L][b];
      hMed[b] = median(col, n);
    }
    for (let b = 0; b < B; b++) {
      let n = 0;
      for (let f = Math.max(0, b - vl); f <= Math.min(B - 1, b + vl); f++) col[n++] = m[f];
      const p = median(col, n), h = hMed[b], hh = h * h, pp = p * p;
      mask[b] = hh + pp > 1e-20 ? hh / (hh + pp) : 0.5;
    }
    // Only the harmonic part is resynthesised: the percussive part is the rest of the signal, since the
    // masks add up to one and the windows reconstruct perfectly.
    for (let g = 0; g < G; g++) {
      const P = specs[r][g];
      for (let b = 0; b < B; b++) {
        Y.ar[b] = P.ar[b] * mask[b]; Y.ai[b] = P.ai[b] * mask[b]; Y.br[b] = P.br[b] * mask[b]; Y.bi[b] = P.bi[b] * mask[b];
      }
      inversePair(fft, Y, re, im);
      for (let i = 0; i < N; i++) { re[i] *= win[i]; im[i] *= win[i]; }
      addFrame(harmonic[2 * g], start(j), re);
      if (chans[2 * g + 1]) addFrame(harmonic[2 * g + 1], start(j), im);
    }
    if ((j & 63) === 0) onProgress?.(j / F);
  }
  const percussive = chans.map((x, c) => { const p = new Float32Array(len), h = harmonic[c]; for (let i = 0; i < len; i++) p[i] = x[i] - h[i]; return p; });
  return { harmonic, percussive };
}

// The median of the first n values, by partial sorting in place.
function median(a: Float64Array, n: number): number {
  const k = n >> 1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}
