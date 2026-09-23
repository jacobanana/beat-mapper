// Zero-phase filtering: a biquad run forwards and then backwards over the signal. The two passes
// cancel each other's phase shift, so an attack stays exactly where it was in time. A plain one-pass
// filter would delay the lows by a few milliseconds, which is the size of the lean being measured.

export type FilterKind = 'lowpass' | 'highpass';

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

// RBJ cookbook coefficients, Butterworth Q.
function design(kind: FilterKind, f: number, sr: number): Biquad {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
  const b1 = kind === 'lowpass' ? 1 - c : -(1 + c), b0 = Math.abs(b1) / 2;
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
}

function run(x: Float32Array, q: Biquad, reverse: boolean): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const n = x.length;
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k, v = x[i];
    const y = q.b0 * v + q.b1 * x1 + q.b2 * x2 - q.a1 * y1 - q.a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    x[i] = y;
  }
}

/** A copy of x through each stage in turn, every stage forwards and backwards. */
export function filtfilt(x: Float32Array, sr: number, stages: readonly { kind: FilterKind; f: number }[]): Float32Array {
  const y = x.slice();
  for (const s of stages) {
    const q = design(s.kind, s.f, sr);
    run(y, q, false);
    run(y, q, true);
  }
  return y;
}
