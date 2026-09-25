// Chords: keys, guitar, pads. Non-negative matrix factorisation with one harmonic template per
// semitone (Smaragdis & Brown, WASPAA 2003), as the drum detector does with one template per drum.
//
// Each template is a comb: the partials of one note, each drawn exactly as the spectrogram would show
// a steady partial there. Everywhere else it is zero, and the multiplicative updates keep a zero at
// zero, so a template can learn how loud each of its partials is in this instrument but can never
// become another pitch (the harmonic constraint of Vincent, Bertin & Badeau, IEEE TASLP 2010). Each
// template's activation is then that note's loudness frame by frame, and its rises are the note's
// starts, found the way `pickHits` finds a drum's.
//
// The spectrogram is on a log-frequency axis, three bins a semitone. A window long enough to tell two
// low notes apart smears an attack over a fifth of a second, so each band is read with the shortest
// window that still resolves it (a long one under 250 Hz, a short one above 700 Hz), all centred on the
// same instants. The attack itself is then timed on the waveform, not on these frames.
import { makeFFT } from '../dsp/fft';
import { type Attacks, attackTimes, attacks, centsOf, decimate, hzOfCents, placeStart, tuningOf } from './common';
import type { Note } from './types';

export interface ChordOptions {
  /** Lowest and highest note looked for, MIDI numbers: E1 to C7. */
  lo?: number;
  hi?: number;
  iterations?: number;
  /** Learn each note's partial balance (0 = keep the 1/h combs), and the sparsity penalty. */
  adapt?: number;
  sparsity?: number;
  onProgress?: (fraction: number) => void;
  yieldToEventLoop?: boolean;
}

export interface ChordResult {
  notes: Note[];
  tuning: number;
}

const BPO = 36;
const FMAX = 5000;
/** Window lengths, seconds at the decimated rate, and the frequency each is used up to. */
const SIZES = [{ N: 2048, upTo: 400 }, { N: 1024, upTo: Infinity }];
/**
 * A note over a louder one by an octave, a twelfth, two octaves or a seventeenth, starting with it,
 * is that note's partial when it is this much quieter or more. The combs already expect a note's
 * partials; what an instrument has beyond them lands on these pitches, and on the synthetic keys that
 * stays under a tenth of the lower note, while a note really doubled reads 0.15 and up.
 */
const GHOST = 0.12;
/** A frame every 20 ms. */
const HOP = 0.02;

// |W(δ)| of a Hann window, δ in bins from a partial: 1 on it, 0 from two bins away.
function hannLobe(d: number): number {
  const a = Math.abs(d);
  if (a < 1e-6) return 1;
  if (a >= 2) return 0;
  if (Math.abs(a - 1) < 1e-6) return 0.5;
  return Math.abs(Math.sin(Math.PI * a) / (Math.PI * a * (1 - a * a)));
}

/** How each log bin is read from the FFTs: which size, and which bins with what weights. */
interface LogMap {
  B: number;
  /** Cents of each log bin's centre. */
  cents: Float64Array;
  size: Uint8Array;
  k0: Int32Array;
  k1: Int32Array;
  frac: Float64Array;
}

function logMap(sr: number): LogMap {
  const c0 = 2400 - 100 / 3, B = Math.floor((centsOf(Math.min(FMAX, 0.45 * sr)) - c0) / (1200 / BPO));
  const m: LogMap = { B, cents: new Float64Array(B), size: new Uint8Array(B), k0: new Int32Array(B), k1: new Int32Array(B), frac: new Float64Array(B) };
  for (let j = 0; j < B; j++) {
    const c = c0 + (j * 1200) / BPO, f = hzOfCents(c), s = SIZES.findIndex((z) => f < z.upTo), df = sr / SIZES[s].N;
    const lo = hzOfCents(c - 600 / BPO) / df, hi = hzOfCents(c + 600 / BPO) / df;
    m.cents[j] = c;
    m.size[j] = s;
    // Narrower than an FFT bin: read between the two bins around it. Wider: the energy of the bins in it.
    if (hi - lo < 1) { m.k0[j] = Math.floor(f / df); m.k1[j] = -1; m.frac[j] = f / df - m.k0[j]; }
    else { m.k0[j] = Math.ceil(lo); m.k1[j] = Math.max(Math.ceil(lo), Math.floor(hi)); }
  }
  return m;
}

// One frame of log bins from the magnitude spectra of each size, each scaled so a steady partial of
// amplitude A reads A in every size.
function readLog(m: LogMap, mags: Float64Array[], out: Float32Array, o: number): void {
  for (let j = 0; j < m.B; j++) {
    const g = mags[m.size[j]], k = m.k0[j];
    if (m.k1[j] < 0) out[o + j] = (1 - m.frac[j]) * g[k] + m.frac[j] * g[k + 1];
    else { let s = 0; for (let i = k; i <= m.k1[j]; i++) s += g[i] * g[i]; out[o + j] = Math.sqrt(s); }
  }
}

/**
 * A note's template: its partials drawn as the spectrogram draws them. Partials fall off as 1/h to
 * start with; the factorisation learns this instrument's own balance. Sparse: only the bins it has.
 */
function template(m: LogMap, sr: number, pitchCents: number): { bins: Int32Array; w: Float64Array } {
  const f0 = hzOfCents(pitchCents), mags = SIZES.map((z) => new Float64Array(z.N / 2 + 2));
  SIZES.forEach((z, s) => {
    const df = sr / z.N, g = mags[s];
    for (let h = 1; h * f0 < Math.min(FMAX, 0.45 * sr) && h <= 16; h++) {
      const k = (h * f0) / df, a = 1 / h;
      for (let i = Math.max(0, Math.ceil(k - 2)); i <= Math.floor(k + 2) && i < g.length; i++) g[i] = Math.hypot(g[i], a * hannLobe(i - k));
    }
  });
  const full = new Float32Array(m.B);
  readLog(m, mags, full, 0);
  let mx = 0, s = 0;
  for (let j = 0; j < m.B; j++) mx = Math.max(mx, full[j]);
  const bins: number[] = [], w: number[] = [];
  for (let j = 0; j < m.B; j++) if (full[j] > 0.02 * mx) { bins.push(j); w.push(full[j]); s += full[j]; }
  return { bins: Int32Array.from(bins), w: Float64Array.from(w.map((v) => v / s)) };
}

interface Spec {
  V: Float32Array;
  F: number;
  B: number;
  m: LogMap;
  hop: number;
  tuning: number;
}

async function spectrogram(y: Float32Array, sr: number, o: ChordOptions): Promise<Spec> {
  const m = logMap(sr), hop = Math.round(HOP * sr), F = Math.max(1, Math.ceil(y.length / hop));
  const V = new Float32Array(F * m.B);
  const ffts = SIZES.map((z) => makeFFT(z.N)), wins = SIZES.map((z) => Float64Array.from({ length: z.N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / z.N)));
  const re = SIZES.map((z) => new Float64Array(z.N)), im = SIZES.map((z) => new Float64Array(z.N)), mags = SIZES.map((z) => new Float64Array(z.N / 2 + 2));
  // For the tuning: where the clear peaks of the middle-sized spectrum sit, in cents, and how loud.
  const pc: number[] = [], pw: number[] = [];
  for (let f = 0; f < F; f++) {
    for (let s = 0; s < SIZES.length; s++) {
      const N = SIZES[s].N, st = f * hop - N / 2, R = re[s], I = im[s], w = wins[s], g = mags[s];
      for (let i = 0; i < N; i++) { const k = st + i; R[i] = k >= 0 && k < y.length ? y[k] * w[i] : 0; I[i] = 0; }
      ffts[s](R, I);
      for (let k = 0; k <= N / 2; k++) g[k] = (Math.hypot(R[k], I[k]) * 4) / N;
    }
    readLog(m, mags, V, f * m.B);
    if (f % 3 === 0) {
      const g = mags[0], df = sr / SIZES[0].N;
      let mx = 0;
      for (let k = 1; k < g.length - 1; k++) mx = Math.max(mx, g[k]);
      for (let k = Math.ceil(80 / df); k < Math.min(g.length - 1, 1500 / df); k++) {
        if (g[k] < 0.1 * mx || g[k] < g[k - 1] || g[k] < g[k + 1]) continue;
        const a = Math.log(g[k - 1] + 1e-12), b = Math.log(g[k]), c = Math.log(g[k + 1] + 1e-12), den = a - 2 * b + c;
        const d = den < 0 ? (0.5 * (a - c)) / den : 0;
        pc.push(centsOf((k + d) * df));
        pw.push(g[k]);
      }
    }
    if ((f & 511) === 0) {
      o.onProgress?.(0.3 * (f / F));
      if (o.yieldToEventLoop) await new Promise((r) => setTimeout(r, 0));
    }
  }
  return { V, F, B: m.B, m, hop, tuning: tuningOf(pc, pw) };
}

/**
 * V ≈ W·H with the combs as W, by the multiplicative updates for KL divergence (β = 1). The drum
 * detector found squared error better because KL let one drum explain another's attack; here KL's
 * leniency is what keeps a note's quiet upper partials from being overruled by the loud low ones.
 */
async function factorise(sp: Spec, combs: { bins: Int32Array; w: Float64Array }[], o: ChordOptions): Promise<Float32Array> {
  const { V, F, B } = sp, K = combs.length, its = o.iterations ?? 40, adapt = o.adapt ?? 0, lam = o.sparsity ?? 0.2;
  const H = new Float64Array(K * F), L = new Float64Array(B), R = new Float64Array(B);
  const W = combs.map((c) => Float64Array.from(c.w)), num = combs.map((c) => new Float64Array(c.w.length)), den = new Float64Array(K);
  let vmax = 0;
  const live = new Uint8Array(F), sum = new Float64Array(F);
  for (let f = 0; f < F; f++) { let s = 0; for (let b = 0; b < B; b++) s += V[f * B + b]; sum[f] = s; vmax = Math.max(vmax, s); }
  // Frames 60 dB under the loudest hold nothing to transcribe; they stay out of the sums.
  for (let f = 0; f < F; f++) if (sum[f] > vmax * 1e-3) { live[f] = 1; for (let k = 0; k < K; k++) H[k * F + f] = sum[f] / K; }
  const eps = 1e-9 * (vmax || 1) / B;
  for (let it = 0; it < its; it++) {
    const learn = it < its * adapt;
    for (let k = 0; k < K; k++) num[k].fill(0);
    den.fill(0);
    for (let f = 0; f < F; f++) {
      if (!live[f]) continue;
      L.fill(eps);
      for (let k = 0; k < K; k++) {
        const h = H[k * F + f];
        if (h === 0) continue;
        const bins = combs[k].bins, w = W[k];
        for (let i = 0; i < bins.length; i++) L[bins[i]] += w[i] * h;
      }
      for (let b = 0; b < B; b++) R[b] = V[f * B + b] / L[b];
      for (let k = 0; k < K; k++) {
        const bins = combs[k].bins, w = W[k];
        let s = 0;
        for (let i = 0; i < bins.length; i++) s += w[i] * R[bins[i]];
        const h = H[k * F + f];
        // Each template sums to 1, so the KL denominator Σ_b W is 1.
        if (learn && h > 0) { const nk = num[k]; for (let i = 0; i < bins.length; i++) nk[i] += h * R[bins[i]]; den[k] += h; }
        H[k * F + f] = (h * s) / (1 + lam);
      }
    }
    // The partials' balance, learnt in the first half and then held while the activations settle.
    if (learn) {
      for (let k = 0; k < K; k++) {
        if (!(den[k] > 0)) continue;
        const w = W[k], nk = num[k];
        let s = 0;
        for (let i = 0; i < w.length; i++) s += w[i] *= nk[i] / den[k];
        if (s > 0) { for (let i = 0; i < w.length; i++) w[i] /= s; for (let f = 0; f < F; f++) H[k * F + f] *= s; }
      }
    }
    o.onProgress?.(0.3 + 0.6 * ((it + 1) / its));
    if (o.yieldToEventLoop) await new Promise((r) => setTimeout(r, 0));
  }
  return Float32Array.from(H);
}

export async function detectChords(x: Float32Array, sr: number, o: ChordOptions = {}): Promise<ChordResult> {
  const { lo = 28, hi = 96 } = o;
  const { y, sr: ys } = decimate(x, sr, 11025);
  const sp = await spectrogram(y, ys, o);
  const combs: { bins: Int32Array; w: Float64Array }[] = [];
  for (let p = lo; p <= hi; p++) combs.push(template(sp.m, ys, 100 * p + sp.tuning));
  const H = await factorise(sp, combs, o);
  const notes = track(H, combs.length, sp.F, lo, ys, sp.hop / ys, sp.tuning, attacks(x, sr));
  o.onProgress?.(1);
  return { notes, tuning: sp.tuning };
}

/**
 * Activations into notes, the onsets gating them (Hawthorne et al., "Onsets and Frames", ISMIR 2018):
 * a note starts at an attack found on the waveform, when its activation just after the attack is well
 * above what it was just before. "Just after" is once the analysis window has passed the attack
 * entirely: a strike's broadband click lights every template for as long as it is in the window, and
 * only a real note is still there when it has left. A note that swells in with no attack (a pad, a
 * slur) starts where its activation climbs past the level a note needs. A note ends where it has
 * fallen 20 dB under its own peak, or where the same pitch starts again. Then the ghosts go: a note an
 * octave, a twelfth, two octaves or a seventeenth over a much louder one that starts with it is that
 * note's partial.
 */
function track(H: Float32Array, K: number, F: number, lo: number, sr: number, dt: number, tuning: number, A: Attacks): Note[] {
  let top = 0;
  for (let i = 0; i < H.length; i++) if (H[i] > top) top = H[i];
  const on = top * 0.03, atk = attackTimes(A), raw: { pitch: number; t: number; a: number; b: number; peak: number }[] = [];
  const at = (h: Float32Array, t: number) => { const f = Math.max(0, Math.min(F - 1, Math.round(t / dt))); return h[f]; };
  for (let k = 0; k < K; k++) {
    const h = H.subarray(k * F, (k + 1) * F), f0 = hzOfCents(100 * (lo + k) + tuning);
    // Half the longest window reading this note's lower partials.
    const hw = SIZES[Math.max(0, SIZES.findIndex((z) => f0 < z.upTo))].N / 2 / sr;
    const starts: { t: number; f: number }[] = [];
    for (const o of atk) {
      const pre = at(h, o.t - hw - dt), post = at(h, o.t + hw + dt), last = starts[starts.length - 1];
      // Two starts of one pitch closer than the window can tell apart are one.
      if (post >= on && post >= 2 * pre && !(last && o.t - last.t < 2 * hw)) starts.push({ t: o.t, f: Math.round(o.t / dt) });
    }
    // Swells: past the level a note needs, three times up on where it was. The window reaches a struck
    // note up to half its length before the attack and takes as long again to be full of it, so a
    // crossing that close to any attack is that attack's, whether or not it started this note.
    for (let f = 1; f < F; f++) {
      if (h[f] < on || h[f - 1] >= on) continue;
      const t = f * dt, pre = at(h, t - 2 * hw - 0.1);
      if (h[f] < 3 * pre || atk.some((o) => Math.abs(o.t - t) <= 1.5 * hw + 0.08)) continue;
      // A note played over a loud chord may not climb over the chord's own peaks, so it isn't among
      // the attacks; it still has an attack of its own on the waveform, looked for where the window
      // reached it.
      const st = placeStart(A, t, 0.03, hw + 0.03);
      starts.push({ t: st.rise >= 6 ? st.t : t, f });
    }
    starts.sort((p, q) => p.t - q.t);
    starts.forEach((s, i) => {
      const stop = i + 1 < starts.length ? Math.round(starts[i + 1].t / dt) : F, full = Math.min(stop, s.f + Math.ceil((2 * hw) / dt) + 1);
      // The peak once the window is full of the note; then on until it has faded 20 dB under it.
      let peak = 0, f = s.f;
      for (let j = s.f; j < full; j++) if (h[j] > peak) { peak = h[j]; f = j; }
      for (; f < stop; f++) if (h[f] < peak * 0.1 || h[f] < on * 0.3) break;
      const end = Math.min(stop * dt, f * dt);
      if (end - s.t >= 0.06 && peak >= on) raw.push({ pitch: lo + k, t: s.t, a: s.f, b: f, peak });
    });
  }
  const ghost = (q: (typeof raw)[number]) => raw.some((p) => [12, 19, 24, 28].includes(q.pitch - p.pitch) && Math.abs(p.t - q.t) < 0.03 && q.peak < GHOST * p.peak);
  const kept = raw.filter((q) => !ghost(q));
  const peaks = kept.map((k) => k.peak).sort((a, b) => a - b), ref = peaks[Math.floor(peaks.length * 0.9)] || 1;
  const notes = kept.map((r): Note => ({ pitch: r.pitch, t: r.t, end: Math.max(r.t + 0.04, r.b * dt), s: Math.sqrt(Math.min(1, r.peak / ref)), a: r.peak }));
  return notes.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
}
