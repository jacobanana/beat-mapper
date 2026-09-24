// Resampling for the .wav files: a windowed sinc, so a file written at another rate keeps what was
// heard and nothing above the new Nyquist folds back in. The ratio between two sample rates is a
// small fraction (48000/44100 is 160/147), so the filter is a polyphase one: the weights for each of
// the L fractional positions are worked out once, exactly, and every output sample is one dot product.

/** How many zero crossings of the sinc each side, at the lower of the two rates. */
const HALF = 32;
/** Kaiser window shape: about 90 dB of stopband, the transition band a sixteenth of the cutoff. */
const BETA = 9;
/** Above this many phases the weights are computed per sample instead of tabled. */
const MAX_PHASES = 4096;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** The zeroth-order modified Bessel function, for the Kaiser window. */
function i0(x: number): number {
  let s = 1, t = 1;
  const h = x / 2;
  for (let k = 1; k < 40; k++) { t *= h / k; const d = t * t; s += d; if (d < s * 1e-12) break; }
  return s;
}

/** The lowpass kernel at distance t (input samples) for cutoff fc (cycles per input sample), zero past `half`. */
function kernel(t: number, fc: number, half: number, i0b: number): number {
  const x = t / half;
  if (x <= -1 || x >= 1) return 0;
  const w = i0(BETA * Math.sqrt(1 - x * x)) / i0b;
  const a = 2 * fc * t;
  return (a === 0 ? 2 * fc : Math.sin(Math.PI * a) / (Math.PI * t)) * w;
}

/** `chans` at `srIn`, resampled to `srOut`. The same arrays back when the rates are equal. */
export function resample(chans: readonly Float32Array[], srIn: number, srOut: number): Float32Array[] {
  if (srIn === srOut || !chans.length) return chans.slice();
  const n = chans[0].length, ratio = srOut / srIn, nOut = Math.max(1, Math.round(n * ratio));
  // Downsampling, the cutoff sits at the new Nyquist and the kernel is longer by the same ratio.
  const fc = Math.min(1, ratio) / 2, half = Math.ceil(HALF / Math.min(1, ratio)), i0b = i0(BETA), taps = 2 * half;
  const g = gcd(srIn, srOut), L = srOut / g, M = srIn / g;
  const out = chans.map(() => new Float32Array(nOut));

  // The weights for output sample j: input samples base-half+1 .. base+half, where base = floor(j·M/L)
  // and the exact position is base + p/L with p = j·M mod L, each weighted by the kernel at its
  // distance from that position, scaled so they sum to one.
  const weights = (frac: number, w: Float32Array) => {
    let sum = 0;
    for (let k = 0; k < taps; k++) { const v = kernel(k - half + 1 - frac, fc, half, i0b); w[k] = v; sum += v; }
    for (let k = 0; k < taps; k++) w[k] /= sum;
  };
  let table: Float32Array | null = null;
  if (L <= MAX_PHASES) {
    table = new Float32Array(L * taps);
    for (let p = 0; p < L; p++) weights(p / L, table.subarray(p * taps, (p + 1) * taps));
  }
  const w = new Float32Array(taps);
  for (let j = 0; j < nOut; j++) {
    const pos = j * M, base = Math.floor(pos / L), p = pos - base * L;
    let ws: Float32Array;
    if (table) ws = table.subarray(p * taps, (p + 1) * taps);
    else { weights(p / L, w); ws = w; }
    // Only the taps inside the audio; those past either end read as silence.
    const i0s = base - half + 1, k0 = Math.max(0, -i0s), k1 = Math.min(taps, n - i0s);
    for (let c = 0; c < chans.length; c++) {
      const src = chans[c];
      let acc = 0;
      for (let k = k0; k < k1; k++) acc += src[i0s + k] * ws[k];
      out[c][j] = acc;
    }
  }
  return out;
}
