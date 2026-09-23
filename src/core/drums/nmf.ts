// Non-negative matrix factorisation of a spectrogram: V ≈ W·H, where each column of W is a spectral
// template (what one instrument sounds like) and each row of H its activation over time (how loud it
// is, frame by frame). Drums suit this well: a hit is roughly one fixed spectrum that swells and
// decays, and when a kick and a hat land together their spectra add, so both keep their own
// activation instead of the louder one winning.
//
// Updates are the multiplicative rules for a β-divergence (Févotte & Idier 2011). β = 2, squared
// error, is the default: KL (β = 1) charges almost nothing for predicting energy in a band that is
// quiet, so a snare template would happily explain a kick's attack and predict wires that aren't
// there. Squared error charges for that as much as for missing energy. The drum templates
// are semi-adaptive (Dittmar & Gärtner 2014): they start as the priors and are free to drift towards
// the recording's own kit, but the prior's pull fades out only gradually, so a template can't wander
// off and swap roles with another. Any extra components are fully free (the partially-fixed NMF of
// Wu & Lerch 2015): in a full mix they soak up the bass, keys and voice, which the drum templates
// would otherwise have to explain.

export interface NmfOptions {
  /** Components learned from scratch, next to the drum templates. */
  free?: number;
  iterations?: number;
  /** How fast the priors let go: the blend weight is (1 - i/iterations)^beta. */
  beta?: number;
  /** The β of the β-divergence: 1 is KL, 2 is squared error. */
  divergence?: number;
  seed?: number;
}

export interface NmfResult {
  /** Templates, K of them, `bands` values each, every one summing to 1. */
  readonly W: Float32Array;
  /** Activations, K rows of `frames` values. */
  readonly H: Float32Array;
  readonly K: number;
}

/**
 * Factorises V (frames × bands, frame-major) with the given templates as the first components.
 * Row k of H is template k's activation.
 */
export function nmf(V: Float32Array, frames: number, bands: number, priors: readonly Float32Array[], o: NmfOptions = {}): NmfResult {
  const { free = 0, iterations = 40, beta = 3, divergence = 2 } = o, bd = divergence, D = priors.length, K = D + free, F = frames, B = bands;
  let seed = o.seed ?? 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const W = new Float64Array(K * B), P = new Float64Array(D * B), H = new Float64Array(K * F);
  for (let k = 0; k < D; k++) {
    let s = 0;
    for (let b = 0; b < B; b++) s += priors[k][b];
    for (let b = 0; b < B; b++) W[k * B + b] = P[k * B + b] = priors[k][b] / (s || 1);
  }
  for (let k = D; k < K; k++) {
    let s = 0;
    for (let b = 0; b < B; b++) s += W[k * B + b] = 0.1 + rnd();
    for (let b = 0; b < B; b++) W[k * B + b] /= s;
  }
  let vmax = 0;
  for (let f = 0; f < F; f++) {
    let s = 0;
    for (let b = 0; b < B; b++) s += V[f * B + b];
    if (s > vmax) vmax = s;
    for (let k = 0; k < K; k++) H[k * F + f] = (s / K) * (0.5 + (k < D ? 0.5 : rnd()));
  }
  const eps = 1e-9 * (vmax || 1), R = new Float64Array(F * B), Q = new Float64Array(F * B), num = new Float64Array(K * B), den = new Float64Array(K * B);

  // R = V·Λ^(β-2) and Q = Λ^(β-1), Λ = W·H: the numerator and denominator weights of the β updates.
  const ratio = () => {
    for (let f = 0; f < F; f++) {
      for (let b = 0; b < B; b++) {
        let l = eps;
        for (let k = 0; k < K; k++) l += W[k * B + b] * H[k * F + f];
        // Math.pow is slow, and β is nearly always 1 or 2.
        const v = V[f * B + b];
        if (bd === 2) { R[f * B + b] = v; Q[f * B + b] = l; }
        else if (bd === 1) { R[f * B + b] = v / l; Q[f * B + b] = 1; }
        else { R[f * B + b] = v * Math.pow(l, bd - 2); Q[f * B + b] = Math.pow(l, bd - 1); }
      }
    }
  };

  for (let it = 0; it < iterations; it++) {
    // H ← H · (Wᵀ R) / (Wᵀ Q)
    ratio();
    for (let f = 0; f < F; f++) {
      for (let k = 0; k < K; k++) {
        let s = 0, q = 0;
        for (let b = 0; b < B; b++) { s += W[k * B + b] * R[f * B + b]; q += W[k * B + b] * Q[f * B + b]; }
        H[k * F + f] *= s / (q || eps);
      }
    }
    // W ← W · (R Hᵀ) / (Q Hᵀ), then the drum templates are pulled back towards their priors.
    ratio();
    num.fill(0);
    den.fill(0);
    for (let f = 0; f < F; f++) {
      for (let k = 0; k < K; k++) {
        const h = H[k * F + f];
        if (h === 0) continue;
        for (let b = 0; b < B; b++) { num[k * B + b] += h * R[f * B + b]; den[k * B + b] += h * Q[f * B + b]; }
      }
    }
    const alpha = Math.pow(1 - (it + 1) / iterations, beta);
    for (let k = 0; k < K; k++) {
      let s = 0;
      for (let b = 0; b < B; b++) s += W[k * B + b] = (W[k * B + b] * num[k * B + b]) / (den[k * B + b] + eps);
      if (!(s > 0)) continue;
      // Keep each template summing to 1 and move its scale into the activation; blending two
      // templates that each sum to 1 keeps that.
      for (let b = 0; b < B; b++) {
        const w = W[k * B + b] / s;
        W[k * B + b] = k < D ? alpha * P[k * B + b] + (1 - alpha) * w : w;
      }
      for (let f = 0; f < F; f++) H[k * F + f] *= s;
    }
  }
  return { W: Float32Array.from(W), H: Float32Array.from(H), K };
}
