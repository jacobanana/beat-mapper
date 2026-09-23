// Fine placement of a coarse candidate time. The candidate comes from spectral flux, which peaks
// wherever the most spectral change happens; on a kick or snare that is often the hat or noise layer
// arriving 10-30 ms after the attack, so the marker used to land on the decay. Here the 65 ms around
// the candidate is read in two views, in 1 ms blocks:
//   amp: |x| after a 2-pole ~100 Hz high-pass. What the eye sees on the waveform, minus the sub-bass
//        ripple that would otherwise look like a rise every half cycle.
//   dif: |x[j]-x[j-1]|, tilted 6 dB/oct to the highs. Catches a hat or snare over a sustained tone.
// Per view: main rise = the earliest 1 ms rise near the candidate that is at least 85% of the
// steepest one (an attack beats a slightly bigger bump behind it, such as a pad beat joining a
// hat); floor = quietest 6 ms before it; peak = loudest 8 ms after it. The onset is the start of
// the region above floor+25% of the range that holds the main rise, walked back while above
// floor+8%, then down to the sample: first sample over the floor, back to where the pre-hit signal
// was still quiet. A view with less than 1.6:1 contrast abstains (noise alone reads about 1.4:1,
// a real hit 1.7:1 and up); amp is trusted first, dif second, else the steepest amp rise.
export function refineOnset(x: Float32Array, sr: number, tc: number): number {
  const blk = Math.max(1, Math.round(sr * 0.001));
  const a = Math.max(2, Math.floor((tc - 0.045) * sr)), b = Math.min(x.length, Math.ceil((tc + 0.02) * sr));
  const nb = Math.floor((b - a) / blk);
  if (nb < 12) return Math.max(0, tc);
  const n = b - a, amp = new Float32Array(n), dif = new Float32Array(n);
  const r = Math.exp((-2 * Math.PI * 100) / sr), w0 = Math.max(1, a - Math.round(sr * 0.02));
  let y1 = 0, y2 = 0, px = x[w0 - 1], py = 0;
  for (let j = w0; j < b; j++) {
    const v = x[j];
    y1 = r * (y1 + v - px); px = v;
    y2 = r * (y2 + y1 - py); py = y1;
    if (j >= a) { amp[j - a] = Math.abs(y2); dif[j - a] = Math.abs(v - x[j - 1]); }
  }
  const c = Math.round((tc * sr - a) / blk);
  const view = (s: Float32Array) => {
    const h = new Float32Array(nb);
    let e0 = 0, e1 = 0;
    for (let i = 0; i < nb; i++) {
      let m = 0;
      for (let j = i * blk, e = j + blk; j < e; j++) if (s[j] > m) m = s[j];
      h[i] = Math.max(m, e0, e1); e1 = e0; e0 = m;
    }
    const lo = Math.max(2, c - 30), hi = Math.min(nb, c + 20);
    let bi = lo, bd = -1;
    for (let i = lo; i < hi; i++) { const d = h[i] - Math.min(h[i - 1], h[i - 2]); if (d > bd) { bd = d; bi = i; } }
    for (let i = lo; i < bi; i++) { const d = h[i] - Math.min(h[i - 1], h[i - 2]); if (d >= 0.85 * bd) { bi = i; break; } }
    let floor = Infinity;
    for (let j = 0; j + 6 <= bi - 1; j++) { let m = 0; for (let k = j; k < j + 6; k++) m += h[k]; if (m / 6 < floor) floor = m / 6; }
    if (floor === Infinity) { floor = 0; for (let k = 0; k < bi; k++) floor += h[k]; floor = bi ? floor / bi : 0; }
    let peak = 0;
    for (let i = bi; i < Math.min(nb, bi + 8); i++) if (h[i] > peak) peak = h[i];
    const ratio = peak / (floor + 1e-9), ok = peak > 1e-4 && ratio > 1.6;
    let T = floor + 0.25 * (peak - floor), i = bi;
    while (i > 0 && h[i - 1] >= T) i--;
    // The quietest stretch may predate an earlier hit whose tail this one rides on. The contrast test
    // keeps it, but the walk-backs re-read the floor from the 6 ms right before the region, so the
    // tail is not mistaken for part of this hit.
    if (i > 0) {
      let m = 0, cnt = 0;
      for (let k = Math.max(0, i - 6); k < i; k++) { m += h[k]; cnt++; }
      if (cnt && m / cnt > floor) { floor = m / cnt; T = floor + 0.25 * (peak - floor); i = bi; while (i > 0 && h[i - 1] >= T) i--; }
    }
    const Tl = floor + 0.08 * (peak - floor);
    const i0 = i;
    while (i > 0 && i0 - i < 12 && h[i - 1] >= Tl) i--;
    const thr = floor * 1.6 + 0.06 * (peak - floor), s0 = i * blk, s1 = Math.min(n, (bi + 2) * blk);
    let sp = s0;
    while (sp < s1 && s[sp] <= thr) sp++;
    if (sp >= s1) sp = bi * blk;
    const low = floor * 1.15 + 1e-7, lim = Math.max(s0, sp - Math.round(sr * 0.002));
    let quiet = 0, on = sp;
    for (let k = sp - 1; k >= lim; k--) { if (s[k] <= low) { if (++quiet >= 3) break; } else { quiet = 0; on = k; } }
    return { ok, ratio, t: Math.max(0, (a + on - 1) / sr), rise: (a + bi * blk) / sr };
  };
  const A = view(amp);
  if (A.ok) return A.t;
  const D = view(dif);
  // A hit over a loud pad can leave amp short of contrast. Its onset still counts when the bright
  // layer dif found comes clearly later: that is a kick then a hat, not a lone hat (whose amp rise,
  // if any, coincides with dif's). Anything under 1.45:1 is within what noise alone reads.
  if (D.ok && A.ratio > 1.45 && D.t - A.t >= 0.008) return A.t;
  if (D.ok) return D.t;
  return A.rise;
}

// Pulls a time onto a zero crossing so the marker sits where the waveform is at rest, not mid-swing.
// Looks back first (up to 2 ms): landing before the hit keeps the whole attack. Only when nothing
// behind crosses zero does it look ahead, and then just 1 ms; otherwise the time is left alone.
// The reach is short on purpose: a hit riding on a bass note or a low rumble has no zero crossing of
// its own nearby, and a longer search would drag the marker onto the bass's crossing, well ahead of the hit.
export function snapToZero(x: Float32Array, sr: number, t: number): number {
  const n = x.length;
  if (n < 2) return t;
  const i = Math.max(1, Math.min(n - 1, Math.round(t * sr)));
  const cross = (k: number) => {
    const a = x[k - 1], b = x[k];
    if (a === 0) return k - 1;
    if (b === 0) return k;
    return a < 0 !== b < 0 ? k - 1 + a / (a - b) : -1;
  };
  const back = Math.round(sr * 0.002), fwd = Math.round(sr * 0.001);
  for (let k = i; k >= 1 && k > i - back; k--) { const c = cross(k); if (c >= 0) return c / sr; }
  for (let k = i + 1; k < n && k <= i + fwd; k++) { const c = cross(k); if (c >= 0) return c / sr; }
  return t;
}
