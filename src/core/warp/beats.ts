// Drums: cut at every transient and move each piece to where the warp puts its transient, playing it
// at its own speed, as REX files and Ableton's Beats mode do. Nothing is stretched, so every hit keeps
// its attack and its sound exactly; a piece that no longer fits is faded out just before the next
// hit, and one with room to spare ends a little early in silence: a gap. The price is on sustained
// sounds, which break into steps; that is what the other modes are for.
import type { Progress } from './frames';
import type { WarpMap } from './map';

export interface BeatsOptions {
  /** Where each piece starts, source seconds, sorted. */
  transients: readonly number[];
  /** Fade at the end of each piece, seconds. */
  fade?: number;
  /**
   * Fill the gaps: a piece with room to spare plays on through it instead of stopping, as Beat
   * Detective's Fill Gaps does. Playing on through the source would sound the next hit early (its
   * attack is what follows the piece), so the piece's own tail is played back and forth instead, as
   * Ableton's Beats mode loops it, dying away into the next hit.
   */
  fill?: boolean;
}

/** One piece of Drums mode: source seconds s..e, laid down from output time d, with room until D. */
export interface Piece {
  readonly s: number;
  readonly e: number;
  readonly d: number;
  readonly D: number;
}

/** How long a piece is heard: all of it, or as much as fits before the next. */
export const heardLen = (p: Piece): number => Math.max(0, Math.min(p.e - p.s, p.D - p.d));

/** Gaps shorter than this (seconds) are rounding, not silence anyone hears. */
const MIN_GAP = 0.001;
/** A gap holds the source moment just before the next piece starts: the end of what was heard. */
const HOLD = 1e-6;

/**
 * Where Drums mode puts the audio: every piece whole, at its own speed, so a piece is cut short where
 * the next starts (the rest of it is not heard) or leaves a gap before it. The same pieces are
 * rendered and drawn, so what is drawn is what is heard.
 */
export class Cuts {
  /** `b` is the source moment at the end of the output. */
  constructor(readonly pieces: readonly Piece[], readonly b: number) {}

  /** The source seconds cut up, from `a` to `b`: from the first piece to the end of the warp. */
  get a(): number { return this.pieces.length ? this.pieces[0].s : this.b; }
  /** Output time the first piece starts at: before it, silence put ahead of the audio. */
  get start(): number { return this.pieces.length ? this.pieces[0].d : 0; }

  /** Output time the source moment s is heard at; a moment cut off is held where the next piece starts. */
  dstAt(s: number): number {
    const p = this.pieces[at(this.pieces, s, (q) => q.s)];
    if (!p) return s;
    return p.d + Math.max(0, Math.min(s - p.s, heardLen(p), p.D - p.d));
  }

  /** The source moment heard at output time d; in a gap, the end of the piece before it. */
  srcAt(d: number): number {
    const p = this.pieces[at(this.pieces, d, (q) => q.d)];
    if (!p) return d;
    const off = Math.max(0, d - p.d), len = heardLen(p);
    return off < len ? p.s + off : Math.max(p.s, p.s + len - HOLD);
  }

  /** The stretches of source heard, in order, between output times d0 and d1: `[from, to]` pairs. */
  heard(d0: number, d1: number): [number, number][] {
    const out: [number, number][] = [], P = this.pieces;
    for (let i = Math.max(0, at(P, d0, (q) => q.d)); i < P.length && P[i].d < d1; i++) {
      const p = P[i], a = Math.max(d0, p.d), b = Math.min(d1, p.d + heardLen(p));
      if (b > a) out.push([p.s + (a - p.d), p.s + (b - p.d)]);
    }
    return out;
  }

  /** Output time ranges between d0 and d1 where a piece ends before the next begins. */
  gaps(d0 = -Infinity, d1 = Infinity): [number, number][] {
    const out: [number, number][] = [], P = this.pieces;
    for (let i = Math.max(0, at(P, d0, (q) => q.d)); i < P.length && P[i].d < d1; i++) {
      const p = P[i], a = p.d + heardLen(p);
      if (p.D - a >= MIN_GAP && p.D > d0) out.push([a, p.D]);
    }
    return out;
  }
}

// The last piece starting at or before v, or -1 before the first.
function at(P: readonly Piece[], v: number, key: (p: Piece) => number): number {
  let lo = 0, hi = P.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (key(P[m]) <= v) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

/**
 * The pieces Drums mode cuts: one from the source at the output's first moment, so the lead-in is
 * kept, then one per transient up to the output's end at `outDur`. `srcEnd` is where the source runs out.
 */
export function planCuts(w: WarpMap, transients: readonly number[], srcEnd: number, outDur: number): Cuts {
  const first = Math.max(0, w.srcAt(0)), end = w.srcAt(outDur);
  const starts = [first, ...transients.filter((t) => t > first + 0.001 && t < end)];
  return new Cuts(starts.map((s, i) => {
    const last = i + 1 === starts.length;
    return { s, e: last ? srcEnd : starts[i + 1], d: w.dstAt(s), D: last ? outDur : w.dstAt(starts[i + 1]) };
  }), end);
}

export function sliceWarp(chans: readonly Float32Array[], sr: number, w: WarpMap, n: number, o: BeatsOptions, onProgress?: Progress): Float32Array[] {
  const len = chans[0].length, fade = Math.round((o.fade ?? 0.004) * sr), fadeIn = Math.round(0.0003 * sr);
  const out = chans.map(() => new Float32Array(n));
  const P = planCuts(w, o.transients, len / sr, n / sr).pieces;
  for (let i = 0; i < P.length; i++) {
    const p = P[i], s0 = Math.round(p.s * sr), s1 = Math.round(p.e * sr), d0 = Math.round(p.d * sr), d1 = Math.round(p.D * sr);
    const m = Math.min(s1 - s0, d1 - d0, len - s0, n - d0);
    if (m <= 0) continue;
    // Filled, the piece runs to the next one, its tail going back and forth over the last quarter of
    // it (10 to 80 ms): no jump in the waveform where it turns, so no click.
    const M = o.fill ? Math.min(d1 - d0, n - d0) : m, W = Math.max(1, Math.min(m, Math.round(Math.max(0.01 * sr, Math.min(0.08 * sr, m / 4)))));
    const f = Math.min(fade, M >> 1), fi = i === 0 ? 0 : Math.min(fadeIn, m >> 2);
    for (let c = 0; c < chans.length; c++) {
      const x = chans[c], y = out[c];
      for (let j = 0; j < M; j++) {
        let g = 1, k = j;
        if (j >= m) {
          const r = (j - m) % (2 * W);
          k = r < W ? m - 1 - r : m - W + (r - W);
          // The fill dies away, as the hit it carries on would.
          g = 1 - (j - m) / (M - m);
        }
        if (j < fi) g *= j / fi;
        else if (j >= M - f) g *= (M - j) / f;
        y[d0 + j] = x[s0 + k] * g;
      }
    }
    if ((i & 31) === 0) onProgress?.(i / P.length);
  }
  return out;
}
