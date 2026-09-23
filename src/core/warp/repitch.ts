// Re-pitch: play the audio faster or slower, as a turntable or a sampler does, so the pitch moves
// with the tempo. Nothing is cut or overlapped, so there are no artefacts at all; for a small
// correction to a live take the change in pitch is often too small to hear.
import type { Progress } from './frames';
import type { WarpMap } from './map';

export function repitch(chans: readonly Float32Array[], sr: number, w: WarpMap, n: number, onProgress?: Progress): Float32Array[] {
  const len = chans[0].length;
  return chans.map((x, c) => {
    const y = new Float32Array(n), at = (i: number) => (i >= 0 && i < len ? x[i] : 0);
    for (let i = 0; i < n; i++) {
      const p = w.srcAt(i / sr) * sr, i0 = Math.floor(p), t = p - i0;
      // Four-point cubic Hermite: smooth, and exact on the samples themselves.
      const a = at(i0 - 1), b = at(i0), d = at(i0 + 1), e = at(i0 + 2);
      y[i] = b + 0.5 * t * (d - a + t * (2 * a - 5 * b + 4 * d - e + t * (3 * (b - d) + e - a)));
      if ((i & 65535) === 0) onProgress?.((c + i / n) / chans.length);
    }
    return y;
  });
}
