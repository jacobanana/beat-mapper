// Pieces every overlap-add algorithm shares: windows, reading a frame anywhere in a signal, and
// the progress callback.

export type Progress = (fraction: number) => void;

/** Periodic Hann: copies of it spaced by N/2 add up to exactly 1, and their squares at N/4 to 1.5. */
export function hann(N: number): Float64Array {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  return w;
}

/** Square-root Hann: used for analysis and synthesis both, it reconstructs perfectly at N/2 spacing. */
export function sqrtHann(N: number): Float64Array {
  const w = hann(N);
  for (let i = 0; i < N; i++) w[i] = Math.sqrt(w[i]);
  return w;
}

/** The power of two closest to `sec` of audio, so a window lasts about as long at any sample rate. */
export function pow2For(sec: number, sr: number): number {
  return 1 << Math.max(6, Math.round(Math.log2(sec * sr)));
}

/** N samples of x from `start`, times the window, into `out`; zeros where x has none. */
export function readFrame(x: Float32Array, start: number, w: Float64Array, out: Float64Array): void {
  const N = w.length, n = x.length;
  for (let i = 0; i < N; i++) { const j = start + i; out[i] = j >= 0 && j < n ? x[j] * w[i] : 0; }
}

/** Adds `frame` into `out` at `start`, skipping what falls outside. */
export function addFrame(out: Float32Array, start: number, frame: ArrayLike<number>, gain = 1): void {
  const n = out.length, N = frame.length, i0 = Math.max(0, -start), i1 = Math.min(N, n - start);
  for (let i = i0; i < i1; i++) out[start + i] += frame[i] * gain;
}

export const princarg = (p: number): number => p - 2 * Math.PI * Math.round(p / (2 * Math.PI));

export function mixDown(chans: readonly Float32Array[]): Float32Array {
  if (chans.length === 1) return chans[0];
  const n = chans[0].length, m = new Float32Array(n), g = 1 / chans.length;
  for (const c of chans) for (let i = 0; i < n; i++) m[i] += c[i] * g;
  return m;
}

/** Calls `onProgress` at most every 2 %, so a worker isn't flooded with messages. */
export function throttle(onProgress: Progress | undefined, from = 0, to = 1): Progress {
  let last = -1;
  return (f) => {
    const v = from + (to - from) * Math.max(0, Math.min(1, f));
    if (onProgress && v - last >= 0.02) { last = v; onProgress(v); }
  };
}

/** Half-spectra (bins 0..N/2) of a pair of real frames. */
export interface Pair {
  ar: Float64Array; ai: Float64Array;
  br: Float64Array; bi: Float64Array;
}

export const newPair = (B: number): Pair => ({ ar: new Float64Array(B), ai: new Float64Array(B), br: new Float64Array(B), bi: new Float64Array(B) });

type FFT = (re: Float64Array, im: Float64Array) => void;

// Two real signals go through one complex FFT, one as the real part and one as the imaginary, and are
// told apart afterwards by symmetry: half the transforms for stereo, which is where the time goes.

/** The spectra of frames `a` and `b` (b may be all zeros) into `out`, using `re` and `im` as scratch. */
export function forwardPair(fft: FFT, a: Float64Array, b: Float64Array | null, re: Float64Array, im: Float64Array, out: Pair): void {
  const N = re.length, B = N / 2 + 1;
  re.set(a);
  if (b) im.set(b); else im.fill(0);
  fft(re, im);
  for (let k = 0; k < B; k++) {
    const j = (N - k) % N;
    out.ar[k] = (re[k] + re[j]) / 2; out.ai[k] = (im[k] - im[j]) / 2;
    out.br[k] = (im[k] + im[j]) / 2; out.bi[k] = (re[j] - re[k]) / 2;
  }
}

/** Frames `a` and `b` back from their half-spectra in `p`, into `re` and `im`. */
export function inversePair(fft: FFT, p: Pair, re: Float64Array, im: Float64Array): void {
  const N = re.length, B = N / 2 + 1;
  for (let k = 0; k < B; k++) {
    const ar = p.ar[k], ai = p.ai[k], br = p.br[k], bi = p.bi[k];
    // Conjugated, so the forward FFT does the inverse: z[k] = conj(A + iB), and the mirror bin to match.
    re[k] = ar - bi; im[k] = -(ai + br);
    if (k > 0 && k < N / 2) { re[N - k] = ar + bi; im[N - k] = -(br - ai); }
  }
  fft(re, im);
  for (let i = 0; i < N; i++) { re[i] /= N; im[i] = -im[i] / N; }
}
