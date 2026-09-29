// Open or closed: a closed hat is a tick that is gone in a few tens of milliseconds, an open one a
// wash that rings until the pedal closes it, often right on the next hat. So each hat is told by how
// long it rings: how long its activation takes to fall 12 dB from its peak. When the next hat comes
// before that, the decay seen so far is carried on at the same rate, so an open hat choked after a
// sixteenth is still heard as open, and a closed one followed closely is not.
import type { DrumHit } from './voices';

/** A hat that takes longer than this (seconds) to fall 12 dB is open. Closed hats take 20 to 60 ms. */
export const OPEN_HAT_LEN = 0.1;

/** How far the level falls for a sound to count as over: 12 dB, a quarter of the peak. */
const DROP = 0.25;
/** No hat rings longer than this, seconds: the longest ring time reported. */
const MAX_LEN = 2;
// A spectrogram frame is a 23 ms window centred on its time, so the next hit is already in the
// frames from half a window before it: the ring is only read up to there.
const NEXT_GUARD = 0.015;

/**
 * How long a sound in activation `h` (frames at `fr` per second) rings, seconds: from its peak, at
 * most 30 ms after `t`, to where it has fallen 12 dB. `until` is where the next hit of the same voice
 * begins; the fall is extrapolated from the part before it when the sound hasn't died by then.
 */
export function ringTime(h: Float32Array, fr: number, t: number, until = Infinity): number {
  let p = -1, peak = 0;
  for (let n = Math.max(0, Math.floor((t - 0.005) * fr)), e = Math.min(h.length - 1, Math.ceil((t + 0.03) * fr)); n <= e; n++) {
    if (h[n] > peak) { peak = h[n]; p = n; }
  }
  if (p < 0) return 0;
  const end = Math.min(h.length - 1, Math.floor((until - NEXT_GUARD) * fr), p + Math.ceil(MAX_LEN * fr));
  let lo = peak, jl = p;
  for (let j = p + 1; j <= end; j++) {
    if (h[j] <= peak * DROP) {
      // Between frames, where the line from the one before crosses the level.
      const f = (h[j - 1] - peak * DROP) / Math.max(1e-12, h[j - 1] - h[j]);
      return (j - 1 - p + f) / fr;
    }
    if (h[j] < lo) { lo = h[j]; jl = j; }
  }
  // The next hit comes on the peak itself: there is no ring to read, so it counts as closed.
  if (end <= p) return 0;
  if (jl === p) return MAX_LEN;
  // Not over before the next hit: the same exponential decay, carried on to 12 dB down.
  return Math.min(MAX_LEN, ((jl - p) / fr) * (Math.log(DROP) / Math.log(lo / peak)));
}

/**
 * The hats with the open ones marked, from the hat activation. `hats` are sorted by time; each rings
 * until the next one at the latest (the pedal closing, or another stroke, cuts it).
 */
export function markOpenHats<T extends DrumHit>(hats: readonly T[], h: Float32Array, fr: number): T[] {
  return hats.map((x, i) => (ringTime(h, fr, x.t, i + 1 < hats.length ? hats[i + 1].t : Infinity) >= OPEN_HAT_LEN ? { ...x, open: true } : x));
}
