/** Mixes channels down to one, averaging them. */
export function mixToMono(chans: readonly Float32Array[]): Float32Array {
  const n = chans[0]?.length ?? 0, ch = chans.length, x = new Float32Array(n);
  for (const d of chans) for (let i = 0; i < n; i++) x[i] += d[i] / ch;
  return x;
}

export function peakOf(x: Float32Array): number {
  let pk = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i] < 0 ? -x[i] : x[i]; if (v > pk) pk = v; }
  return pk;
}

interface Level { bin: number; mn: Float32Array; mx: Float32Array }

/**
 * Min/max summaries of a signal at 64, 256, 1024… samples per bin, so the waveform can be drawn at
 * any zoom by reading a few thousand bins instead of millions of samples.
 */
export class PeakPyramid {
  private readonly levels: Level[] = [];

  constructor(readonly x: Float32Array) {
    let bin = 64, n = Math.ceil(x.length / 64), mn = new Float32Array(n), mx = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let a = 1, b = -1;
      for (let j = i * 64, e = Math.min(x.length, j + 64); j < e; j++) { const v = x[j]; if (v < a) a = v; if (v > b) b = v; }
      mn[i] = a; mx[i] = b;
    }
    this.levels.push({ bin, mn, mx });
    while (n > 2000) {
      const pn = n, pmn = mn, pmx = mx;
      n = Math.ceil(pn / 4); bin *= 4; mn = new Float32Array(n); mx = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let a = 1, b = -1;
        for (let j = i * 4, e = Math.min(pn, j + 4); j < e; j++) { if (pmn[j] < a) a = pmn[j]; if (pmx[j] > b) b = pmx[j]; }
        mn[i] = a; mx[i] = b;
      }
      this.levels.push({ bin, mn, mx });
    }
  }

  /** [min, max] of samples s0..s1, or null for an empty range. */
  minmax(s0: number, s1: number): [number, number] | null {
    const x = this.x;
    s0 = Math.max(0, s0); s1 = Math.min(x.length, s1);
    if (s1 <= s0) return null;
    const span = s1 - s0;
    let a = 1, b = -1;
    if (span < 128) {
      for (let i = s0; i < s1; i++) { const v = x[i]; if (v < a) a = v; if (v > b) b = v; }
      return [a, b];
    }
    let L = this.levels[0];
    for (const l of this.levels) { if (l.bin * 2 <= span) L = l; else break; }
    const i0 = Math.floor(s0 / L.bin), i1 = Math.min(L.mn.length, Math.ceil(s1 / L.bin));
    for (let i = i0; i < i1; i++) { if (L.mn[i] < a) a = L.mn[i]; if (L.mx[i] > b) b = L.mx[i]; }
    return [a, b];
  }
}
