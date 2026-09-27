// The spectrogram under the piano roll, on synthetic parts whose notes are known: each note's
// fundamental lands in its row, the fundamentals view lights it and dims its partials, and the
// harmonics-removed view takes the partials out.
import { beforeAll, describe, expect, it } from 'vitest';
import { type PitchSpectrogram, SPEC_HI, SPEC_LO, SPEC_PER, levelAt, pitchSpectrogram, viewSpectrogram } from '../src/core/notes/spectrogram';
import { synthBass, synthKeys } from '../src/core/notes/synth';

const SR = 44100, bass = synthBass(SR), keys = synthKeys(SR);
let sb: PitchSpectrogram, sk: PitchSpectrogram;

beforeAll(async () => {
  sb = await pitchSpectrogram(bass.x, SR, { yieldToEventLoop: false });
  sk = await pitchSpectrogram(keys.x, SR, { yieldToEventLoop: false });
}, 60_000);

/** A frame well into a note but before a bend (the bass's start 150 ms in), and the first bin of a pitch's row. */
const mid = (s: PitchSpectrogram, n: { t: number; end: number }) => Math.round((n.t + Math.min(0.08, (n.end - n.t) / 2)) * s.fr);
const row = (s: PitchSpectrogram, pitch: number) => (pitch - s.lo) * s.perSemitone;
/** The loudest bin of a frame, as a pitch. */
function loudest(s: PitchSpectrogram, V: Float32Array, f: number): number {
  let b = 0;
  for (let j = 1; j < s.bins; j++) if (V[f * s.bins + j] > V[f * s.bins + b]) b = j;
  return s.lo - 0.5 + (b + 0.5) / s.perSemitone;
}
/** The loudest of a pitch's three bins in a frame, dB. */
function at(s: PitchSpectrogram, V: Float32Array, f: number, pitch: number): number {
  const r = f * s.bins + row(s, pitch);
  return Math.max(V[r], V[r + 1], V[r + 2]);
}

describe('the pitch spectrogram', () => {
  it('covers A0 to C8, three bins a semitone, a frame every 23 ms', () => {
    expect([sb.lo, sb.bins, sb.perSemitone]).toEqual([SPEC_LO, (SPEC_HI - SPEC_LO + 1) * SPEC_PER, SPEC_PER]);
    expect(sb.fr).toBeGreaterThan(40);
    expect(sb.fr).toBeLessThan(50);
    expect(sb.frames).toBe(Math.ceil((bass.dur * sb.fr)));
  });

  it('puts each bass note in its own row, 20 cents flat included, and the loudest bin on it', () => {
    const V = viewSpectrogram(sb, 'audio', 8);
    let on = 0;
    for (const n of bass.notes) {
      const f = mid(sb, n);
      expect(at(sb, V, f, n.pitch), `${n.pitch} at ${n.t.toFixed(2)}`).toBeGreaterThan(at(sb, V, f, n.pitch + 5));
      // Within a bin of its row: the whole part is 20 cents flat, on the edge of the middle bin.
      if (Math.abs(loudest(sb, V, f) - n.pitch) < 0.7) on++;
    }
    expect(on).toBeGreaterThanOrEqual(bass.notes.length - 2);
  });

  it('reads how loud a note is at its pitch over its length, and next to nothing a fourth away', () => {
    const n = bass.notes[0];
    expect(levelAt(sb, n.pitch, n.t, n.end)).toBeGreaterThan(10 * levelAt(sb, n.pitch + 5, n.t, n.end));
    expect(levelAt(sb, 0, n.t, n.end)).toBe(0);
  });
});

describe('the views', () => {
  it('lights the fundamentals and dims the partials: the octave over a bass note drops by 20 dB and more', () => {
    const raw = viewSpectrogram(sb, 'audio', 8), fund = viewSpectrogram(sb, 'fundamental', 8);
    let dimmed = 0;
    for (const n of bass.notes) {
      const f = mid(sb, n), before = at(sb, raw, f, n.pitch + 12) - at(sb, raw, f, n.pitch), after = at(sb, fund, f, n.pitch + 12) - at(sb, fund, f, n.pitch);
      if (after < before - 20) dimmed++;
      expect(Math.abs(loudest(sb, fund, f) - n.pitch), `${n.pitch} at ${n.t.toFixed(2)}`).toBeLessThan(0.7);
    }
    expect(dimmed).toBeGreaterThanOrEqual(bass.notes.length - 3);
  });

  it('takes the harmonics out and leaves the fundamentals as they were', () => {
    const raw = viewSpectrogram(sb, 'audio', 8), clean = viewSpectrogram(sb, 'clean', 8);
    let gone = 0;
    for (const n of bass.notes) {
      const f = mid(sb, n);
      expect(Math.abs(at(sb, clean, f, n.pitch) - at(sb, raw, f, n.pitch))).toBeLessThan(3);
      if (at(sb, clean, f, n.pitch + 12) < at(sb, raw, f, n.pitch + 12) - 20) gone++;
    }
    expect(gone).toBeGreaterThanOrEqual(bass.notes.length - 3);
  });

  it('keeps every note of a chord in the fundamentals view, and one partial alone is not a note', () => {
    const fund = viewSpectrogram(sk, 'fundamental', 8);
    // Each chord: every note of it stands over what sits a whole tone above it, where nothing plays.
    let kept = 0;
    for (const n of keys.notes) {
      const f = mid(sk, n);
      if (at(sk, fund, f, n.pitch) > at(sk, fund, f, n.pitch + 2) + 6) kept++;
    }
    expect(kept).toBeGreaterThanOrEqual(keys.notes.length - 3);
  });

  it('is as heard with one harmonic, whatever the view', () => {
    const raw = viewSpectrogram(sb, 'audio', 8);
    expect(viewSpectrogram(sb, 'fundamental', 1)).toEqual(raw);
    expect(viewSpectrogram(sb, 'clean', 1)).toEqual(raw);
  });
});
