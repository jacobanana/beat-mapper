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
//
// Which notes there are is decided chord by chord. A factorisation never splits a piano's energy
// cleanly: the combs a semitone either side of a low note, and the combs on its partials, take some of
// it too. Tracked one pitch at a time, each of those looks like a note. Asked together at each onset
// (which pitches did this onset start, and which of them only rose because a louder one did), they fall
// away.
import { makeFFT } from '../dsp/fft';
import { type Attacks, attacks, centsOf, decimate, hzOfCents, placeStart, tuningOf } from './common';
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
 * A note on a louder one's partial (an octave, a twelfth, two octaves, a seventeenth and on up to three
 * octaves over it) that starts with it is that partial, when it rose by under this fraction of what the
 * lower note did; an octave, under half of it. The combs expect a note's partials at 1/h; what a piano
 * has beyond that lands on these pitches, and reads up to 0.11 of the lower note. An octave really
 * doubled reads 0.08 and up, since the lower comb takes some of it.
 */
const GHOST = 0.12;
const PARTIALS = [12, 19, 24, 28, 31, 34, 36];
/**
 * A note a semitone from a louder one that starts with it is the louder one's spill when it rose by
 * under half as much; under 400 Hz a window can't tell two notes a whole tone apart either.
 */
const NEIGHBOUR = 0.5;
/** A note that rose by under this fraction of the loudest note of its onset isn't one of the chord. */
const QUIET = 0.03;
/** The least rise a note needs, against the loudest activation of the take. */
const ON = 0.015;
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
  const notes = track(H, combs.length, sp.F, lo, ys, sp.hop / ys, sp.tuning, attacks(x, sr), onsets(y, ys));
  o.onProgress?.(1);
  return { notes, tuning: sp.tuning };
}

/**
 * Where notes start: peaks of the spectral flux (Dixon, DAFx 2006) on 46 ms windows every 5 ms, each
 * bin measured against the loudest of its neighbours 15 ms before, so a partial that wobbles in pitch
 * doesn't read as a new note (Böck & Widmer's SuperFlux, DAFx 2013). The waveform's own envelope only
 * shows a note that is loud over what is already ringing; a soft melody note over a held chord barely
 * moves the level, but its partials are new, and the flux sees them.
 */
function onsets(y: Float32Array, sr: number): number[] {
  const N = 512, K = N / 2, hop = Math.round(0.005 * sr), F = Math.ceil(y.length / hop), fft = makeFFT(N);
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const re = new Float64Array(N), im = new Float64Array(N), S = new Float32Array(F * K);
  let mx = 0;
  for (let f = 0; f < F; f++) {
    const st = f * hop - N / 2;
    for (let i = 0; i < N; i++) { const k = st + i; re[i] = k >= 0 && k < y.length ? y[k] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < K; k++) { const v = Math.hypot(re[k], im[k]); S[f * K + k] = v; if (v > mx) mx = v; }
  }
  // Compressed, so a soft note's partials count as much as a loud one's.
  for (let i = 0; i < S.length; i++) S[i] = Math.log10(1 + (1000 * S[i]) / (mx || 1));
  const mu = 3, k0 = Math.max(1, Math.floor((60 * N) / sr)), nov = new Float32Array(F);
  let top = 0;
  for (let f = mu; f < F; f++) {
    const p = (f - mu) * K;
    let s = 0;
    for (let k = k0; k < K - 1; k++) { const d = S[f * K + k] - Math.max(S[p + k - 1], S[p + k], S[p + k + 1]); if (d > 0) s += d; }
    nov[f] = s;
    if (s > top) top = s;
  }
  // A peak, the highest within 30 ms, standing over the mean of the 150 ms before it by 5% of the
  // highest of the take.
  const W = Math.round(0.03 / 0.005), M = Math.round(0.15 / 0.005), out: number[] = [];
  for (let f = 1; f < F; f++) {
    let peak = nov[f] > 0;
    for (let j = Math.max(0, f - W); peak && j <= Math.min(F - 1, f + W); j++) if (nov[j] > nov[f] || (nov[j] === nov[f] && j < f)) peak = false;
    if (!peak) continue;
    let mean = 0, n = 0;
    for (let j = Math.max(0, f - M); j <= Math.min(F - 1, f + W); j++) { mean += nov[j]; n++; }
    if (nov[f] >= mean / n + 0.05 * top) out.push((f * hop) / sr);
  }
  return out;
}

interface Start {
  pitch: number;
  t: number;
  /** How much its activation rose at the onset, and the frame it rose from. */
  gain: number;
  f: number;
}

/**
 * Activations into notes, the onsets gating them (Hawthorne et al., "Onsets and Frames", ISMIR 2018).
 * At each onset every pitch is asked how far its activation rose: from just before the window reached
 * the onset to the least it has once the window has passed it entirely. A strike's broadband click
 * lights every template while it is in the window, and only a real note is still there when it has
 * left. The pitches that rose are then taken loudest first, and one is left out when it is only the
 * spill of a louder one a semitone away, or its partial, or too quiet beside the rest of the chord.
 * A note ends where it has fallen 20 dB under its own peak, or where the same pitch starts again.
 */
function track(H: Float32Array, K: number, F: number, lo: number, sr: number, dt: number, tuning: number, A: Attacks, ons: number[]): Note[] {
  let top = 0;
  for (let i = 0; i < H.length; i++) if (H[i] > top) top = H[i];
  const on = top * ON, at = (h: Float32Array, f: number) => h[Math.max(0, Math.min(F - 1, f))];
  // Half the longest window reading each note's lower partials, in frames.
  const half = Array.from({ length: K }, (_, k) => {
    const f0 = hzOfCents(100 * (lo + k) + tuning);
    return Math.max(1, Math.round(SIZES[Math.max(0, SIZES.findIndex((z) => f0 < z.upTo))].N / 2 / sr / dt));
  });
  const starts: Start[] = [], last = new Float64Array(K).fill(-Infinity);
  // On the waveform where it shows the attack; a soft note under a loud chord stays where the flux put it.
  const times = ons.map((o) => { const st = placeStart(A, o, 0.03, 0.03); return st.rise >= 6 ? st.t : o; });
  times.forEach((t, i) => {
    const f = Math.round(t / dt), next = i + 1 < times.length ? Math.round(times[i + 1] / dt) : Infinity, rose: Start[] = [];
    for (let k = 0; k < K; k++) {
      const h = H.subarray(k * F, (k + 1) * F), L = half[k];
      // Two starts of one pitch closer than the window can tell apart are one: a note the last onset
      // started is still filling the window at this one, and would pass for this one's.
      if (f - last[k] < 2 * L) continue;
      const pre = f - L - 1 < 0 ? 0 : Math.max(at(h, f - L - 1), at(h, f - L - 2));
      // After this onset has left the window and before the next one is in it. Onsets closer together
      // than the window leave no such frame: then the frame half way between, which still hears this
      // onset's thump, and the first clear of it, which already hears the next note; a note of this
      // onset is in both.
      let post = Infinity;
      const j1 = Math.min(f + 2 * L + 1, next - L - 1);
      if (j1 < f + L + 1) post = Math.min(at(h, Math.round((f + next) / 2)), at(h, f + L + 1));
      for (let j = f + L + 1; j <= j1; j++) post = Math.min(post, at(h, j));
      if (post >= on && post >= 2 * pre && post - pre >= on) rose.push({ pitch: lo + k, t, gain: post - pre, f });
    }
    rose.sort((p, q) => q.gain - p.gain);
    const chord: Start[] = [];
    for (const c of rose) {
      if (c.gain < QUIET * rose[0].gain) break;
      const spill = chord.some((p) => { const d = Math.abs(c.pitch - p.pitch); return (d === 1 || (d === 2 && hzOfCents(100 * c.pitch) < 400)) && c.gain < NEIGHBOUR * p.gain; });
      const partial = chord.some((p) => PARTIALS.includes(c.pitch - p.pitch) && c.gain < (c.pitch - p.pitch === 12 ? GHOST / 2 : GHOST) * p.gain);
      if (!spill && !partial) chord.push(c);
    }
    for (const c of chord) {
      last[c.pitch - lo] = c.f;
      starts.push(c);
    }
  });
  const found: { s: Start; b: number; peak: number }[] = [];
  for (const s of starts) {
    const k = s.pitch - lo, h = H.subarray(k * F, (k + 1) * F), L = half[k];
    const next = starts.find((q) => q.pitch === s.pitch && q.f > s.f), stop = next ? next.f : F;
    // The peak once the window is full of the note; then on until it has faded 20 dB under it.
    let peak = 0, f = s.f;
    for (let j = s.f; j < Math.min(stop, s.f + 2 * L + 2); j++) if (h[j] > peak) { peak = h[j]; f = j; }
    for (; f < stop; f++) if (h[f] < peak * 0.1 || h[f] < on * 0.3) break;
    if (f * dt - s.t >= 0.06) found.push({ s, b: f, peak });
  }
  // The strength the sensitivity reads: the rise against the loud notes of the take, a little
  // compressed, so the starting sensitivity keeps notes down to about 25 dB under them.
  const g = found.map((n) => n.s.gain).sort((a, b) => a - b), ref = g[Math.floor(g.length * 0.9)] || 1;
  const notes = found.map(({ s, b, peak }): Note => ({ pitch: s.pitch, t: s.t, end: Math.max(s.t + 0.04, b * dt), s: Math.pow(Math.min(1, s.gain / ref), 0.8), a: peak }));
  return notes.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
}
