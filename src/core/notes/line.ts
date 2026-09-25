// One line at a time: a bass line, a lead, a voice. pYIN (Mauch & Dixon, ICASSP 2014) for the pitch,
// then notes cut from the pitch the way Tony does it (Mauch et al., TENOR 2015), with the starts and
// ends put on the waveform by its loudness.
//
// YIN (de Cheveigné & Kawahara, JASA 2002) finds a period as the first dip of the cumulative mean
// normalised difference function under a threshold; the first dip, not the deepest, because the dip at
// two periods is often as deep and would put the note an octave down. pYIN tries a spread of
// thresholds instead of one, so every frame gives a few candidate pitches with a probability each, and
// a hidden Markov model picks one path through them all: a single frame an octave off costs more to
// jump to and back from than it explains, which is what cures YIN's octave errors. It is an algorithm
// with hand-set probabilities, not a trained model.
import { makeFFT } from '../dsp/fft';
import { type Attacks, type Envelope, attacks, centsOf, decimate, envelope, peakDb, placeEnd, placeStart, tuningOf } from './common';
import type { BendPoint, Note } from './types';

export interface LineOptions {
  /** Lowest and highest fundamental looked for, Hz: a five-string's low B up to G6. */
  fmin?: number;
  fmax?: number;
  onProgress?: (fraction: number) => void;
  yieldToEventLoop?: boolean;
}

export interface LineResult {
  notes: Note[];
  tuning: number;
}

/**
 * Frames about every 10 ms. The start and end of a note are timed on the envelope, not on these. The
 * hop is a whole number of samples, 110 at 11025 Hz, so a frame is 9.98 ms there: times are read from
 * the hop itself, since counting 10 ms a frame puts a note 0.2 s late by the second minute.
 */
const HOP = 0.01;
/** Pitch states 10 cents apart. */
const BIN = 10;
/** A note shorter than this is part of its neighbour: a slide or the scoop into a note. */
const MIN_NOTE = 0.06;

// The Beta(2, 18) prior over YIN thresholds that pYIN uses: mostly around 0.1, YIN's own threshold.
const THRESHOLDS = (() => {
  const n = 100, p = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) { const x = (i + 0.5) / n; s += p[i] = x * Math.pow(1 - x, 17); }
  for (let i = 0; i < n; i++) p[i] /= s;
  return p;
})();

interface Frames {
  /** Candidates per frame: cents and probability, `C` slots each. */
  cents: Float32Array;
  prob: Float32Array;
  C: number;
  n: number;
  /** Seconds from one frame to the next. */
  dt: number;
}

/** pYIN's first half: candidate pitches and their probabilities, frame by frame. */
async function candidates(y: Float32Array, sr: number, fmin: number, fmax: number, o: LineOptions): Promise<Frames> {
  const tmax = Math.ceil(sr / fmin), tmin = Math.max(2, Math.floor(sr / fmax)), W = Math.max(tmax, Math.round(0.04 * sr));
  let N = 1;
  while (N < W + tmax + 1) N <<= 1;
  const hop = Math.round(HOP * sr), n = Math.max(1, Math.ceil(y.length / hop)), C = 4;
  const fft = makeFFT(N), re = new Float64Array(N), im = new Float64Array(N);
  const cum = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) cum[i + 1] = cum[i] + y[i] * y[i];
  const sq = (a: number, b: number) => cum[Math.max(0, Math.min(y.length, b))] - cum[Math.max(0, Math.min(y.length, a))];
  // Silence has no pitch: frames far under the loudest are unvoiced whatever YIN says.
  let loud = 0;
  for (let i = 0; i + W <= y.length; i += hop) loud = Math.max(loud, sq(i, i + W));
  const floor = loud * 1e-5;
  const cents = new Float32Array(n * C), prob = new Float32Array(n * C), d = new Float64Array(tmax + 2), dn = new Float64Array(tmax + 2);
  const troughs: number[] = [];
  for (let f = 0; f < n; f++) {
    const s = f * hop - ((W + tmax) >> 1);
    if (sq(s, s + W) < floor) continue;
    // r(τ) = Σ a[j]·b[j+τ] for the window a and the longer stretch b, both in one complex FFT.
    for (let i = 0; i < N; i++) {
      const k = s + i, v = k >= 0 && k < y.length ? y[k] : 0;
      re[i] = i < W ? v : 0;
      im[i] = i < W + tmax ? v : 0;
    }
    fft(re, im);
    for (let k = 0; k <= N >> 1; k++) {
      const j = (N - k) & (N - 1);
      const ar = (re[k] + re[j]) / 2, ai = (im[k] - im[j]) / 2, br = (im[k] + im[j]) / 2, bi = (re[j] - re[k]) / 2;
      // conj(A)·B, conjugated again for the inverse through the forward transform.
      const pr = ar * br + ai * bi, pi = ar * bi - ai * br;
      re[k] = pr; im[k] = -pi;
      if (j !== k) { re[j] = pr; im[j] = pi; }
    }
    fft(re, im);
    const e0 = sq(s, s + W);
    let run = 0;
    dn[0] = 1;
    for (let t = 1; t <= tmax; t++) {
      d[t] = Math.max(0, e0 + sq(s + t, s + t + W) - (2 * re[t]) / N);
      run += d[t];
      dn[t] = run > 0 ? (d[t] * t) / run : 1;
    }
    troughs.length = 0;
    let gmin = tmin;
    for (let t = tmin; t < tmax; t++) {
      if (dn[t] < dn[gmin]) gmin = t;
      if (dn[t] < dn[t - 1] && dn[t] <= dn[t + 1]) troughs.push(t);
    }
    if (!troughs.length) continue;
    // Each threshold picks the first trough under it; one no trough is under gives a little to the
    // lowest trough of all, as pYIN does.
    const mass = new Map<number, number>();
    for (let i = 0; i < THRESHOLDS.length; i++) {
      const thr = (i + 1) / THRESHOLDS.length, t = troughs.find((k) => dn[k] < thr);
      const at = t ?? gmin, p = THRESHOLDS[i] * (t === undefined ? 0.01 : 1);
      mass.set(at, (mass.get(at) ?? 0) + p);
    }
    const best = [...mass.entries()].sort((a, b) => b[1] - a[1]).slice(0, C);
    best.forEach(([t, p], c) => {
      // Parabolic interpolation: the dip's true lag lies between samples.
      const a = dn[t - 1], b = dn[t], g = dn[t + 1], den = a - 2 * b + g, dt = den > 0 ? (0.5 * (a - g)) / den : 0;
      cents[f * C + c] = centsOf(sr / (t + Math.max(-0.5, Math.min(0.5, dt))));
      prob[f * C + c] = p;
    });
    if ((f & 1023) === 0) {
      o.onProgress?.(0.6 * (f / n));
      if (o.yieldToEventLoop) await new Promise((r) => setTimeout(r, 0));
    }
  }
  return { cents, prob, C, n, dt: hop / sr };
}

/**
 * pYIN's second half: the most likely path through the candidates. States are pitches every 10 cents
 * plus one unvoiced state. A pitch drifts a bin or two a frame at little cost (vibrato, a bend); any
 * other change is a jump, allowed from anywhere at one fixed price, so a new note costs the same
 * whatever the interval but a lone frame an octave off costs two jumps. Returns cents per frame, NaN
 * where unvoiced, and the probability that carried each frame.
 */
function viterbi(fr: Frames, lo: number, hi: number): { cents: Float32Array; voicing: Float32Array } {
  const S = Math.ceil((hi - lo) / BIN) + 1, { n, C } = fr, U = S;
  const JUMP = -9, VOICE = -6, STEP = [0, -0.4, -1.2, -2.4], FLOOR = Math.log(1e-4);
  let prev = new Float64Array(S + 1), cur = new Float64Array(S + 1);
  const back = new Uint8Array(n * (S + 1)), jumpFrom = new Int32Array(n), emit = new Float64Array(S + 1);
  const binOf = (c: number) => Math.round((c - lo) / BIN);
  prev.fill(-1e9);
  prev[U] = 0;
  for (let f = 0; f < n; f++) {
    let pv = 0;
    emit.fill(0);
    for (let c = 0; c < C; c++) {
      const p = fr.prob[f * C + c];
      if (!(p > 0)) continue;
      const b = binOf(fr.cents[f * C + c]);
      if (b < 0 || b >= S) continue;
      pv += p;
      emit[b] += p;
      // A little of each candidate's weight on its neighbours, so a pitch between two bins isn't penalised.
      if (b > 0) emit[b - 1] += 0.3 * p;
      if (b + 1 < S) emit[b + 1] += 0.3 * p;
    }
    let bestB = 0;
    for (let b = 1; b < S; b++) if (prev[b] > prev[bestB]) bestB = b;
    jumpFrom[f] = bestB;
    const fromJump = prev[bestB] + JUMP, fromU = prev[U] + VOICE;
    for (let b = 0; b < S; b++) {
      let v = fromJump, k = 7;
      if (fromU > v) { v = fromU; k = 8; }
      for (let dlt = -3; dlt <= 3; dlt++) {
        const j = b + dlt;
        if (j < 0 || j >= S) continue;
        const w = prev[j] + STEP[Math.abs(dlt)];
        if (w > v) { v = w; k = dlt + 3; }
      }
      cur[b] = v + (emit[b] > 0 ? Math.log(emit[b]) : FLOOR);
      back[f * (S + 1) + b] = k;
    }
    const uStay = prev[U], uFrom = prev[bestB] + VOICE;
    cur[U] = Math.max(uStay, uFrom) + Math.log(Math.max(1e-4, 1 - Math.min(1, pv)));
    back[f * (S + 1) + U] = uStay >= uFrom ? 8 : 7;
    [prev, cur] = [cur, prev];
  }
  let s = U;
  for (let b = 0; b < S; b++) if (prev[b] > prev[s]) s = b;
  const path = new Int32Array(n);
  for (let f = n - 1; f >= 0; f--) {
    path[f] = s;
    const k = back[f * (S + 1) + s];
    s = k === 7 ? jumpFrom[f] : k === 8 ? U : s + (k - 3);
  }
  // Each voiced frame at the measured pitch nearest its state, rather than the state's 10-cent grid,
  // so bends and tuning keep their detail.
  const cents = new Float32Array(n).fill(NaN), voicing = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    if (path[f] === U) continue;
    const c0 = lo + path[f] * BIN;
    let bc = c0, bd = BIN * 2, bp = 0;
    for (let c = 0; c < C; c++) {
      const p = fr.prob[f * C + c], cc = fr.cents[f * C + c];
      if (p > 0 && Math.abs(cc - c0) < bd) { bd = Math.abs(cc - c0); bc = cc; bp = p; }
    }
    cents[f] = bc;
    voicing[f] = bp;
  }
  return { cents, voicing };
}

interface Seg { a: number; b: number; pitch: number }

/** The frames' pitch cut into stretches on one semitone, each a candidate note. */
function segments(cents: Float32Array, tuning: number): Seg[] {
  const n = cents.length, q = new Float32Array(n).fill(NaN);
  // A five-frame median settles the frame where the pitch crosses between two semitones.
  const win: number[] = [];
  for (let f = 0; f < n; f++) {
    if (Number.isNaN(cents[f])) continue;
    win.length = 0;
    for (let j = Math.max(0, f - 2); j <= Math.min(n - 1, f + 2); j++) if (!Number.isNaN(cents[j])) win.push(cents[j]);
    win.sort((a, b) => a - b);
    q[f] = Math.round((win[win.length >> 1] - tuning) / 100);
  }
  const out: Seg[] = [];
  for (let f = 0; f < n; f++) {
    if (Number.isNaN(q[f])) continue;
    const last = out[out.length - 1];
    if (last && last.b === f && last.pitch === q[f]) last.b = f + 1;
    else out.push({ a: f, b: f + 1, pitch: q[f] });
  }
  return out;
}

export async function detectLine(x: Float32Array, sr: number, o: LineOptions = {}): Promise<LineResult> {
  const { fmin = 30, fmax = 1600 } = o;
  const { y, sr: ys } = decimate(x, sr, 11025);
  const fr = await candidates(y, ys, fmin, fmax, o);
  const lo = centsOf(fmin) - 2 * BIN, hi = centsOf(fmax) + 2 * BIN;
  const { cents, voicing } = viterbi(fr, lo, hi);
  o.onProgress?.(0.75);
  const tuning = tuningOf(cents, voicing);
  const env = envelope(x, sr), sharp = attacks(x, sr);
  const segs = segments(cents, tuning);
  const notes = cut(segs, cents, voicing, tuning, x, sr, env, sharp, fr.dt);
  o.onProgress?.(1);
  return { notes, tuning };
}


/**
 * Stretches on one semitone into notes. Two stretches that meet are two notes when there is an
 * attack between them (a new pluck) or the pitch steps across (a hammer-on, a slurred change);
 * a pitch that glides across is one note bent, and a stretch too short to be a note belongs to the
 * one it is part of. One stretch holds two notes when it is plucked again on the same pitch.
 */
function cut(segs: Seg[], cents: Float32Array, voicing: Float32Array, tuning: number, x: Float32Array, sr: number, env: Envelope, sharp: Attacks, dt: number): Note[] {
  // Frame f's pitch is measured on a window centred at f·dt.
  const timeOf = (f: number) => f * dt;
  // Runs of voiced frames: a note never spans unvoiced frames.
  const groups: Seg[][] = [];
  for (const s of segs) {
    const g = groups[groups.length - 1], last = g?.[g.length - 1];
    if (last && last.b === s.a) g.push(s);
    else groups.push([s]);
  }
  const raw: { a: number; b: number; ta: number }[] = [];
  for (const g of groups) {
    // Where a new note may start inside the run: at a change of semitone that steps, or anywhere the
    // same pitch is plucked again.
    const starts: { f: number; t: number }[] = [{ f: g[0].a, t: timeOf(g[0].a) }];
    for (let i = 1; i < g.length; i++) {
      const s = g[i], len = (s.b - s.a) * dt;
      if (len < MIN_NOTE && i < g.length - 1) continue;
      const at = startAt(cents, s.a, dt);
      // A step: the pitch crosses most of a semitone within 30 ms.
      const c0 = cents[Math.max(g[0].a, s.a - 2)], c1 = cents[Math.min(s.b - 1, s.a + 1)];
      const step = Math.abs(c1 - c0) >= 70;
      const atk = attackNear(env, at);
      if ((step || atk >= 6) && len >= MIN_NOTE) starts.push({ f: s.a, t: at });
    }
    // The same pitch plucked again: an attack well inside a stretch.
    for (const s of g) {
      for (let t = timeOf(s.a) + 0.08; t < timeOf(s.b) - 0.05; t += 0.02) {
        const r = attackAt(env, t);
        if (r.rise >= 6 && !starts.some((k) => Math.abs(k.t - r.t) < 0.07)) starts.push({ f: Math.round(r.t / dt), t: r.t });
      }
    }
    starts.sort((p, q) => p.t - q.t);
    const end = g[g.length - 1].b;
    starts.forEach((st, i) => raw.push({ a: st.f, b: i + 1 < starts.length ? starts[i + 1].f : end, ta: st.t }));
  }
  const notes: Note[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i], next = raw[i + 1];
    if (r.b - r.a < 3) continue;
    // The note's pitch: the semitone it spends longest on, which is where it was aimed, whether it
    // was bent up from it or slid into.
    const hist = new Map<number, number>();
    let pv = 0;
    for (let f = r.a; f < r.b; f++) {
      if (Number.isNaN(cents[f])) continue;
      const p = Math.round((cents[f] - tuning) / 100);
      hist.set(p, (hist.get(p) ?? 0) + 1);
      pv += voicing[f];
    }
    if (!hist.size) continue;
    const pitch = [...hist.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    const start = placeStart(sharp, r.ta, 0.06, 0.04);
    const nextStart = next && next.a === r.b ? next.ta : Infinity;
    const limit = Math.min(nextStart, x.length / sr);
    const peak = peakDb(env, start.t, Math.min(limit, start.t + 0.15));
    const end = placeEnd(env, start.t, Math.min(limit, timeOf(r.b)), peak, limit);
    if (end - start.t < 0.03) continue;
    const bend = bendOf(cents, r.a, r.b, pitch, tuning, dt);
    notes.push({ pitch, t: start.t, end, s: pv / (r.b - r.a), a: Math.pow(10, peak / 20), ...(bend ? { bend } : {}) });
  }
  // Clarity folds in loudness against the take's loud notes, so a quiet rumble counts for less.
  const peaks = notes.map((k) => k.a).sort((a, b) => a - b), ref = peaks[Math.floor(peaks.length * 0.9)] || 1;
  return notes.map((k) => ({ ...k, s: Math.min(1, k.s * Math.sqrt(Math.min(1, k.a / ref))) }));
}

// Where the pitch crossed into the stretch starting at frame f: halfway between the frames either side.
function startAt(cents: Float32Array, f: number, dt: number): number {
  return (f > 0 && !Number.isNaN(cents[f - 1]) ? f - 0.5 : f) * dt;
}

// How much the loudness climbs near time t (within 40 ms either side), dB.
function attackNear(e: Envelope, t: number): number {
  let best = 0;
  for (let u = t - 0.04; u <= t + 0.04; u += e.blk) best = Math.max(best, attackAt(e, u).rise);
  return best;
}

// The climb into the block at time t over the 30 ms before it.
function attackAt(e: Envelope, t: number): { t: number; rise: number } {
  const k = Math.round(t / e.blk), L = Math.max(2, Math.round(0.03 / e.blk));
  if (k <= 0 || k >= e.db.length) return { t, rise: 0 };
  let lo = Infinity;
  for (let j = Math.max(0, k - L); j < k; j++) if (e.db[j] < lo) lo = e.db[j];
  // Only a local top of the climb counts, so one attack isn't found at every block of its rise.
  const r = e.db[k] - lo, r1 = k + 1 < e.db.length ? e.db[k + 1] - lo : -Infinity;
  return { t: k * e.blk, rise: r >= r1 ? r : 0 };
}

/** The pitch's moves off the note, every 20 ms, when it leaves it by more than 20 cents at all. */
function bendOf(cents: Float32Array, a: number, b: number, pitch: number, tuning: number, dt: number): BendPoint[] | null {
  const pts: BendPoint[] = [];
  let far = 0;
  // Past the attack: a pluck's first few milliseconds are sharp and settle, which isn't a bend.
  for (let f = a + 3; f < b - 1; f++) {
    if (Number.isNaN(cents[f])) continue;
    const dev = Math.max(-200, Math.min(200, cents[f] - tuning - 100 * pitch));
    far = Math.max(far, Math.abs(dev));
    pts.push({ t: f * dt, cents: Math.round(dev) });
  }
  if (far < 20) return null;
  const out: BendPoint[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || (p.t - last.t >= 0.02 - 1e-9 && Math.abs(p.cents - last.cents) >= 4)) out.push(p);
  }
  return out;
}
