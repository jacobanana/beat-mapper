// The note detector on synthetic parts whose notes are known exactly: a bass line (one note at a time)
// and a keyboard part in chords.
import { beforeAll, describe, expect, it } from 'vitest';
import { detectNotes } from '../src/core/notes/detect';
import { heardNotes, noNoteEdits, noteVelocities, selectNotes } from '../src/core/notes/select';
import { type PlayedNote, synthBass, synthKeys, synthPiano } from '../src/core/notes/synth';
import type { Note, NoteAnalysis } from '../src/core/notes/types';
import { noteName } from '../src/core/notes/types';
import { TempoMap } from '../src/core/tempo/tempo-map';
import { buildMidi } from '../src/io/formats/midi';

const SR = 44100, bass = synthBass(SR), keys = synthKeys(SR), piano = synthPiano(SR);
let line: NoteAnalysis, chords: NoteAnalysis, low: NoteAnalysis;

beforeAll(async () => {
  line = await detectNotes(bass.x, SR, { mode: 'line', yieldToEventLoop: false });
  chords = await detectNotes(keys.x, SR, { mode: 'chords', yieldToEventLoop: false });
  low = await detectNotes(piano.x, SR, { mode: 'chords', yieldToEventLoop: false });
}, 60_000);

// Each true note and the found note of its pitch that starts nearest it, within 50 ms (the usual
// onset tolerance of transcription scores).
function match(truth: readonly PlayedNote[], found: readonly Note[]) {
  const pairs = truth.map((n) => ({ n, m: found.filter((k) => k.pitch === n.pitch && Math.abs(k.t - n.t) < 0.05).sort((a, b) => Math.abs(a.t - n.t) - Math.abs(b.t - n.t))[0] }));
  const extra = found.filter((k) => !truth.some((n) => n.pitch === k.pitch && Math.abs(k.t - n.t) < 0.05));
  return { pairs, extra };
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

describe('one line at a time', () => {
  it('finds every note of the bass line at its pitch, and nothing else', () => {
    const { pairs, extra } = match(bass.notes, selectNotes(line.notes, 55, noNoteEdits()));
    expect(pairs.filter((p) => !p.m).map((p) => noteName(p.n.pitch) + '@' + p.n.t.toFixed(2))).toEqual([]);
    expect(extra).toEqual([]);
  });

  it('times each start on the waveform to a few milliseconds', () => {
    const err = match(bass.notes, line.notes).pairs.map((p) => Math.abs(p.m!.t - p.n.t) * 1000);
    expect(Math.max(...err)).toBeLessThan(5);
    expect(median(err)).toBeLessThan(1.5);
  });

  it('ends each note where the player let it go', () => {
    for (const { n, m } of match(bass.notes, line.notes).pairs) {
      expect(Math.abs(m!.end - n.end), noteName(n.pitch) + '@' + n.t.toFixed(2)).toBeLessThan(Math.max(0.05, 0.2 * (n.end - n.t)));
    }
  });

  // Frames are a whole number of samples apart, 110 at 11025 Hz: 9.98 ms, not 10. Counted as 10 ms,
  // a note two minutes in was placed a quarter of a second late, and the short parts never showed it.
  it('keeps two minutes in as well timed as the first bar', async () => {
    const long = synthBass(SR, 80), r = await detectNotes(long.x, SR, { mode: 'line', yieldToEventLoop: false });
    const late = long.notes.filter((n) => n.t > long.dur - 10);
    const err = match(late, r.notes).pairs.map((p) => (p.m ? Math.abs(p.m.t - p.n.t) * 1000 : Infinity));
    expect(late.length).toBeGreaterThan(20);
    expect(median(err)).toBeLessThan(2);
  }, 60_000);

  it('measures the tuning, 20 cents flat', () => {
    expect(line.tuning).toBeCloseTo(bass.tuning, 0);
  });

  it('keeps a bent note one note, with its bend, and leaves the others straight', () => {
    const bent = match(bass.notes, line.notes).pairs.filter((p) => p.n.pitch === 45);
    expect(bent.length).toBe(2);
    for (const { m } of bent) {
      const top = Math.max(...(m!.bend ?? []).map((b) => b.cents));
      expect(top).toBeGreaterThan(170);
      expect(top).toBeLessThanOrEqual(200);
    }
    const straight = line.notes.filter((k) => k.pitch !== 45 && k.bend);
    expect(straight.length).toBeLessThanOrEqual(1);
  });
});

describe('chords', () => {
  it('finds every note of every chord, doubled octaves included, and at most one stray', () => {
    const { pairs, extra } = match(keys.notes, selectNotes(chords.notes, 55, noNoteEdits()));
    expect(pairs.filter((p) => !p.m).map((p) => noteName(p.n.pitch) + '@' + p.n.t.toFixed(2))).toEqual([]);
    expect(extra.length).toBeLessThanOrEqual(1);
  });

  it('starts every note of a chord on its attack', () => {
    const err = match(keys.notes, chords.notes).pairs.map((p) => Math.abs(p.m!.t - p.n.t) * 1000);
    expect(Math.max(...err)).toBeLessThan(6);
    expect(median(err)).toBeLessThan(1.5);
  });

  // Except the G3 doubling the G2 under it: as the chord rings, the factorisation hands the upper
  // octave's energy to the lower note, whose partials those are too, and G3 ends early.
  it('ends each note within the usual tolerance, but for an octave doubling', () => {
    for (const { n, m } of match(keys.notes, chords.notes).pairs) {
      if (n.pitch === 55) continue;
      expect(Math.abs(m!.end - n.end), noteName(n.pitch) + '@' + n.t.toFixed(2)).toBeLessThan(Math.max(0.05, 0.2 * (n.end - n.t)));
    }
  });
});

// A loop's piano, voiced low: chords over octave roots from E1 up, and a soft melody over them. The
// factorisation spills the low notes into the combs a semitone away and onto their partials, and each
// of those, tracked on its own, was a note: this part came out with half as many strays as notes.
describe('chords voiced low, with a melody over them', () => {
  const name = (n: { pitch: number; t: number }) => noteName(n.pitch) + '@' + n.t.toFixed(2);

  it('finds the chords and the melody, with no spill a semitone off a low note', () => {
    const { pairs, extra } = match(piano.notes, selectNotes(low.notes, 55, noNoteEdits()));
    // The D5 over the G chord is the G3's third partial as well; the factorisation leaves it little.
    expect(pairs.filter((p) => !p.m).map((p) => name(p.n)).length).toBeLessThanOrEqual(1);
    expect(extra.length).toBeLessThanOrEqual(1);
    const spill = low.notes.filter((k) => piano.notes.some((n) => n.pitch < 48 && Math.abs(n.pitch - k.pitch) === 1 && Math.abs(n.t - k.t) < 0.05));
    expect(spill.map(name)).toEqual([]);
  });

  it('has a sensitivity that means something: up, every note; down, the roots are left', () => {
    const at = (sens: number) => match(piano.notes, selectNotes(low.notes, sens, noNoteEdits()));
    expect(at(80).pairs.filter((p) => !p.m).map((p) => name(p.n))).toEqual([]);
    const down = at(30).pairs, roots = down.filter((p) => !piano.notes.some((n) => n.pitch < p.n.pitch && Math.abs(n.t - p.n.t) < 0.01));
    expect(down.filter((p) => !p.m).length).toBeGreaterThan(5);
    expect(roots.filter((p) => p.n.pitch < 36 && !p.m).map((p) => name(p.n))).toEqual([]);
  });
});

describe('from found to heard', () => {
  const n = (pitch: number, t: number, end: number, a = 1, s = 1): Note => ({ pitch, t, end, a, s });

  it('lets the sensitivity through and the deletions out', () => {
    const all = [n(40, 0, 0.2, 1, 0.9), n(43, 0.3, 0.5, 1, 0.05), n(45, 0.6, 0.8, 1, 0.5)];
    expect(selectNotes(all, 55, noNoteEdits()).map((k) => k.pitch)).toEqual([40, 45]);
    expect(selectNotes(all, 100, noNoteEdits()).map((k) => k.pitch)).toEqual([40, 43, 45]);
    expect(selectNotes(all, 55, { removed: [{ pitch: 45, t: 0.6 }] }).map((k) => k.pitch)).toEqual([40]);
  });

  it('holds each note to the next with Legato, a chord to the next chord, never into its own pitch', () => {
    const all = [n(40, 0, 0.1), n(52, 0.002, 0.1), n(43, 0.5, 0.6), n(43, 0.55, 0.7)];
    const h = heardNotes(all, true);
    expect(h.map((k) => [k.pitch, k.t, +k.end.toFixed(3)])).toEqual([[40, 0, 0.5], [52, 0.002, 0.5], [43, 0.5, 0.55], [43, 0.55, 0.7]]);
    expect(heardNotes(all, false)[0].end).toBe(0.1);
  });

  it('gives a ghost note 16 dB down a velocity in the 50s', () => {
    const v = noteVelocities([n(40, 0, 1), n(40, 1, 2), n(40, 2, 3, Math.pow(10, -16 / 20))]);
    expect(v[0]).toBe(112);
    expect(v[2]).toBeGreaterThan(49);
    expect(v[2]).toBeLessThan(60);
  });
});

describe('MIDI', () => {
  it('writes pitched notes on a track of their own, with their lengths and bends', () => {
    const map = new TempoMap([{ q: 0, t: 0, manual: true }, { q: 4, t: 2, manual: true }], 120);
    const { bytes } = buildMidi({
      map, meter: { num: 4, den: 4 }, dur: 2, mode: 'pins', trimmed: true,
      pitched: [{ t: 0, end: 0.5, pitch: 40, vel: 100, bend: [{ t: 0.25, cents: 100 }] }, { t: 0.5, end: 1, pitch: 43, vel: 90 }],
    });
    const s = Array.from(bytes);
    const has = (seq: number[]) => s.some((_, i) => seq.every((b, j) => s[i + j] === b));
    expect(bytes[11]).toBe(2); // tempo track and the notes
    expect(has([0x90, 40, 100])).toBe(true);
    expect(has([0x80, 40, 0])).toBe(true);
    expect(has([0x90, 43, 90])).toBe(true);
    // Up a semitone is half the ±2 semitone range: 8192 + 4096.
    expect(has([0xe0, 12288 & 127, 12288 >> 7])).toBe(true);
    // The wheel goes back to the middle before the next note.
    expect(has([0xe0, 0, 64])).toBe(true);
  });
});
