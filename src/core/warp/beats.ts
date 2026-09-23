// Drums: cut at every transient and move each piece to where the warp puts its transient, playing it
// at its own speed, as REX files and Ableton's Beats mode do. Nothing is stretched, so every hit keeps
// its attack and its sound exactly; a piece that no longer fits is faded out just before the next
// hit, and one with room to spare ends a little early in silence. The price is on sustained sounds,
// which break into steps; that is what the other modes are for.
import type { Progress } from './frames';
import type { WarpMap } from './map';

export interface BeatsOptions {
  /** Where each piece starts, source seconds, sorted. */
  transients: readonly number[];
  /** Fade at the end of each piece, seconds. */
  fade?: number;
}

export function sliceWarp(chans: readonly Float32Array[], sr: number, w: WarpMap, n: number, o: BeatsOptions, onProgress?: Progress): Float32Array[] {
  const len = chans[0].length, fade = Math.round((o.fade ?? 0.004) * sr), fadeIn = Math.round(0.0003 * sr);
  const out = chans.map(() => new Float32Array(n));
  // The source at the file's first output sample starts a piece of its own, so the lead-in is kept too.
  const first = Math.max(0, w.srcAt(0)), end = w.srcAt(n / sr);
  const starts = [first, ...o.transients.filter((t) => t > first + 0.001 && t < end)];
  for (let i = 0; i < starts.length; i++) {
    const s0 = Math.round(starts[i] * sr), s1 = i + 1 < starts.length ? Math.round(starts[i + 1] * sr) : len;
    const d0 = Math.round(w.dstAt(starts[i]) * sr), d1 = i + 1 < starts.length ? Math.round(w.dstAt(starts[i + 1]) * sr) : n;
    const m = Math.min(s1 - s0, d1 - d0, len - s0, n - d0);
    if (m <= 0) continue;
    const f = Math.min(fade, m >> 1), fi = i === 0 ? 0 : Math.min(fadeIn, m >> 2);
    for (let c = 0; c < chans.length; c++) {
      const x = chans[c], y = out[c];
      for (let j = 0; j < m; j++) {
        let g = 1;
        if (j < fi) g = j / fi;
        else if (j >= m - f) g = (m - j) / f;
        y[d0 + j] = x[s0 + j] * g;
      }
    }
    if ((i & 31) === 0) onProgress?.(i / starts.length);
  }
  return out;
}
