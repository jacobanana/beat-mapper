// What both note detectors share: a lighter copy of the audio to look for pitch in, a fine loudness
// envelope to time starts and ends on, the tuning, and how a note's start is placed on the waveform.
import { filterForward, filtfilt } from '../dsp/filter';

/**
 * The audio low-passed and decimated to about `target` Hz: pitch lives well below 4 kHz, and a
 * quarter of the samples is a quarter of the work. An integer factor keeps it a plain decimation, and
 * the zero-phase low-pass moves nothing in time.
 */
export function decimate(x: Float32Array, sr: number, target: number): { y: Float32Array; sr: number } {
  const d = Math.max(1, Math.floor(sr / target));
  if (d === 1) return { y: x, sr };
  const f = filtfilt(x, sr, [{ kind: 'lowpass', f: (0.42 * sr) / d }, { kind: 'lowpass', f: (0.42 * sr) / d }]);
  const y = new Float32Array(Math.floor(x.length / d));
  for (let i = 0; i < y.length; i++) y[i] = f[i * d];
  return { y, sr: sr / d };
}

/**
 * Loudness in dB every `blk` seconds, each value the mean power over `win` seconds centred on its
 * block. The window is as long as the lowest note's period: shorter, and a bass note's own waveform
 * would ripple the level like a string of attacks.
 */
export interface Envelope {
  readonly db: Float32Array;
  readonly blk: number;
  readonly win: number;
}

export function envelope(x: Float32Array, sr: number, blk = 0.004, win = 0.03): Envelope {
  const n = Math.max(1, Math.round(blk * sr)), h = Math.max(1, Math.round((win * sr) / 2)), B = Math.ceil(x.length / n), db = new Float32Array(B);
  const cum = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cum[i + 1] = cum[i] + x[i] * x[i];
  for (let k = 0; k < B; k++) {
    const c = k * n + (n >> 1), a = Math.max(0, c - h), b = Math.min(x.length, c + h);
    db[k] = 10 * Math.log10((cum[b] - cum[a]) / Math.max(1, b - a) + 1e-12);
  }
  return { db, blk: n / sr, win: (2 * h) / sr };
}

/**
 * What note starts are timed on: the audio above 150 Hz, and its envelope in 2 ms blocks over 4 ms
 * windows. The pluck, the hammer and the upper partials start with the note; a bass note's
 * fundamental would ripple a window this short, so it is left out.
 */
export interface Attacks {
  readonly env: Envelope;
  readonly hp: Float32Array;
  readonly sr: number;
}

export function attacks(x: Float32Array, sr: number): Attacks {
  // Forwards only, so nothing rings ahead of the attack.
  const hp = filterForward(x, sr, [{ kind: 'highpass', f: 150 }, { kind: 'highpass', f: 150 }]);
  return { env: envelope(hp, sr, 0.002, 0.004), hp, sr };
}

/** The loudest the envelope gets between times a and b, in dB. */
export function peakDb(e: Envelope, a: number, b: number): number {
  let m = -240;
  for (let k = Math.max(0, Math.floor(a / e.blk)), K = Math.min(e.db.length - 1, Math.ceil(b / e.blk)); k <= K; k++) if (e.db[k] > m) m = e.db[k];
  return m;
}

/**
 * The strongest attack in the envelope between times a and b: the block where the loudness climbs
 * most over the 30 ms before it, and by how many dB. A pluck climbs 10 dB and more; a new pitch slurred
 * out of the last one hardly climbs at all.
 */
export function attackIn(e: Envelope, a: number, b: number): { t: number; rise: number } {
  const L = Math.max(2, Math.round(0.03 / e.blk));
  let best = { k: -1, lo: 0, m: 0, rise: 0 };
  for (let k = Math.max(1, Math.floor(a / e.blk)), K = Math.min(e.db.length - 1, Math.ceil(b / e.blk)); k <= K; k++) {
    let lo = Infinity, m = k;
    for (let j = Math.max(0, k - L); j < k; j++) if (e.db[j] < lo) { lo = e.db[j]; m = j; }
    if (e.db[k] - lo > best.rise) best = { k, lo, m, rise: e.db[k] - lo };
  }
  if (best.k < 0) return { t: a, rise: 0 };
  // The climb's start, not its top: the first block after the quiet one that is half way up (in dB).
  // Partials beating make the climb uneven, so walking back from the top would stop on a wobble.
  let s = best.m;
  while (s < best.k && e.db[s] < best.lo + best.rise / 2) s++;
  return { t: s * e.blk, rise: best.rise };
}

/**
 * Where a note that starts about `tc` begins, to the sample: the attack the envelope shows near it,
 * then the first sample of the high-passed audio to stand clear of what came before. (The transients'
 * `refineOnset` is tuned to drums and reads a bass note's own waveform as rises.) A start with no attack
 * to speak of, a slurred change of pitch, stays where the pitch says it changed.
 */
export function placeStart(A: Attacks, tc: number, before = 0.06, after = 0.04): { t: number; rise: number } {
  const at = attackIn(A.env, Math.max(0, tc - before), tc + after);
  if (at.rise < 6) return { t: tc, rise: at.rise };
  const { hp, sr } = A, c = Math.round(at.t * sr), w = Math.round(0.006 * sr);
  let floor = 0, peak = 0;
  for (let i = Math.max(0, c - w - Math.round(0.01 * sr)); i < c - w; i++) floor = Math.max(floor, Math.abs(hp[i]));
  for (let i = c; i < Math.min(hp.length, c + Math.round(0.01 * sr)); i++) peak = Math.max(peak, Math.abs(hp[i]));
  const thr = Math.max(3 * floor, 0.1 * peak);
  for (let i = Math.max(0, c - w); i < Math.min(hp.length, c + w); i++) if (Math.abs(hp[i]) > thr) return { t: i / sr, rise: at.rise };
  return { t: at.t, rise: at.rise };
}

/**
 * Every attack in the audio: where the sharp envelope climbs 8 dB or more over its last 30 ms, the strongest
 * climb within 50 ms either side, each placed to the sample. A chord struck is one attack for all its
 * notes; which notes it started is for the pitch to say.
 */
export function attackTimes(A: Attacks, minRise = 8): { t: number; rise: number }[] {
  const e = A.env, L = Math.max(2, Math.round(0.03 / e.blk)), G = Math.max(1, Math.round(0.05 / e.blk)), n = e.db.length;
  // Measured against the loudest of the 30 ms before, not the quietest: partials beating in a held
  // chord dip and swell by 10 dB in a 4 ms window, but never climb over their own recent peaks.
  const rise = new Float32Array(n);
  for (let k = 3; k < n; k++) {
    let hi = -Infinity;
    for (let j = Math.max(0, k - L); j < k - 2; j++) if (e.db[j] > hi) hi = e.db[j];
    rise[k] = e.db[k] - hi;
  }
  const out: { t: number; rise: number }[] = [];
  for (let k = 1; k < n; k++) {
    if (rise[k] < minRise) continue;
    let top = true;
    for (let j = Math.max(0, k - G); top && j <= Math.min(n - 1, k + G); j++) if (rise[j] > rise[k] || (rise[j] === rise[k] && j < k)) top = false;
    if (top) out.push(placeStart(A, k * e.blk, 0.03, 0.01));
  }
  return out;
}

/**
 * Where a note that sounds until about `tc` (by pitch) really ends: its loudness falling away. The
 * player damping a string drops the level 20 dB and more in a few tens of milliseconds, and that fall
 * is the end; otherwise the note ends where it has faded 30 dB under its peak, or at `tc`.
 */
export function placeEnd(e: Envelope, t0: number, tc: number, peak: number, limit: number): number {
  const a = Math.max(t0 + 0.03, tc - 0.08), b = Math.min(limit, tc + 0.06), L = Math.max(2, Math.round(0.03 / e.blk));
  let fall = -1, best = 0;
  for (let k = Math.floor(a / e.blk); k * e.blk < b && k + L < e.db.length; k++) {
    const d = e.db[k] - e.db[k + L];
    if (d > best) { best = d; fall = k; }
  }
  if (best >= 20) {
    // The fall's first block: where the level was still up.
    let k = fall;
    while (k + 1 < e.db.length && e.db[k] - e.db[k + 1] < 1.5 && k - fall < L) k++;
    // A centred window starts to fall half a window before the sound does.
    return Math.max(t0 + 0.02, Math.min(limit, k * e.blk + e.win / 2));
  }
  // Faded under the peak by 30 dB before the pitch let go: that is where it stopped being heard.
  for (let k = Math.ceil(t0 / e.blk), K = Math.min(e.db.length, Math.ceil(tc / e.blk)); k < K; k++) {
    if (e.db[k] < peak - 30 && k * e.blk > t0 + 0.03) return k * e.blk;
  }
  return Math.min(limit, tc);
}

/**
 * How far from A440 the recording is tuned, in cents (-50..50): the circular mean of where each
 * measured pitch sits between two semitones, weighted. Circular, because 49 cents sharp and 49 flat
 * are two cents apart.
 */
export function tuningOf(cents: ArrayLike<number>, weight: ArrayLike<number>): number {
  let c = 0, s = 0;
  for (let i = 0; i < cents.length; i++) {
    const w = weight[i];
    if (!(w > 0)) continue;
    const a = (2 * Math.PI * cents[i]) / 100;
    c += w * Math.cos(a);
    s += w * Math.sin(a);
  }
  return c || s ? (Math.atan2(s, c) * 100) / (2 * Math.PI) : 0;
}

/** Cents above MIDI note 0 (C-1, 8.18 Hz) of a frequency. */
export const centsOf = (f: number): number => 1200 * Math.log2(f / 8.175798915643707);
/** Frequency of a pitch in cents above MIDI note 0. */
export const hzOfCents = (c: number): number => 8.175798915643707 * Math.pow(2, c / 1200);
