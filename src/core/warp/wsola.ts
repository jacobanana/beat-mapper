// Waveform-similarity overlap-add (Verhelst & Roelands, ICASSP 1993). The output is built from short
// windowed frames of the source, laid down at a steady hop. Each frame is read near where the warp
// says, shifted by up to `tol` so that its waveform lines up with the natural continuation of the
// frame before it; the periods of a single voice then join without the beating plain overlap-add
// makes. With `tol` at zero it is plain overlap-add, which keeps short percussive frames tight.
import { type Progress, addFrame, hann, mixDown } from './frames';
import type { WarpMap } from './map';

export interface OlaOptions {
  /** Frame length, seconds. It should hold two periods of the lowest pitch. */
  frame: number;
  /** How far a frame may shift to line up, seconds: half the longest period is enough. */
  tol: number;
}

export function wsola(chans: readonly Float32Array[], sr: number, w: WarpMap, n: number, o: OlaOptions, onProgress?: Progress): Float32Array[] {
  const N = Math.max(8, 2 * Math.round((o.frame * sr) / 2)), H = N / 2, half = N / 2, T = Math.round(o.tol * sr);
  const win = hann(N), mix = mixDown(chans), len = mix.length;
  const out = chans.map(() => new Float32Array(n)), frame = new Float64Array(N);
  const at = (i: number) => (i >= 0 && i < len ? mix[i] : 0);
  let prev = 0;
  const K = Math.ceil(n / H) + 1;
  for (let k = 0; k <= K; k++) {
    const c = k * H, nominal = Math.round(w.srcAt(c / sr) * sr);
    let p = nominal;
    if (k > 0 && T > 0) p = nominal + bestShift(at, prev + H - half, nominal - half, N, T);
    // Every channel takes the same frame, so the stereo image stays where it was.
    chans.forEach((x, ch) => {
      for (let i = 0; i < N; i++) { const j = p - half + i; frame[i] = j >= 0 && j < len ? x[j] * win[i] : 0; }
      addFrame(out[ch], c - half, frame);
    });
    prev = p;
    if ((k & 63) === 0) onProgress?.(k / K);
  }
  return out;
}

// The shift in [-T, T] at which the frame starting at `from + shift` best matches the one starting at
// `want`, by cross-correlation: first every 4th shift on every 4th sample, then the shifts around the
// best one on every 2nd sample. The coarse pass is enough to find the right period; the fine one
// lines it up to the sample.
function bestShift(at: (i: number) => number, want: number, from: number, N: number, T: number): number {
  const score = (d: number, step: number) => {
    let s = 0;
    for (let i = 0; i < N; i += step) s += at(want + i) * at(from + d + i);
    return s;
  };
  let best = 0, bs = -Infinity;
  for (let d = -T; d <= T; d += 4) { const s = score(d, 4); if (s > bs) { bs = s; best = d; } }
  const c = best;
  bs = -Infinity;
  for (let d = Math.max(-T, c - 3); d <= Math.min(T, c + 3); d++) { const s = score(d, 2); if (s > bs) { bs = s; best = d; } }
  return best;
}
