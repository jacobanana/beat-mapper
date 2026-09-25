// The benchmark's own tools (bench/): the MIDI it reads its truth from, and how it scores.
import { describe, expect, it } from 'vitest';
import { readMidi } from '../bench/midi-read';
import { prf, score } from '../bench/score';
import { TempoMap } from '../src/core/tempo/tempo-map';
import { buildMidi } from '../src/io/formats/midi';

describe('the benchmark', () => {
  it('reads back the notes the app writes, in seconds, across a tempo change', () => {
    // Four beats at 120, then four at 60.
    const map = new TempoMap([{ q: 0, t: 0, manual: true }, { q: 4, t: 2, manual: true }, { q: 8, t: 6, manual: true }], 120);
    const pitched = [{ t: 0, end: 0.5, pitch: 40, vel: 100 }, { t: 1, end: 1.5, pitch: 43, vel: 90 }, { t: 3, end: 4, pitch: 45, vel: 80 }];
    const { bytes } = buildMidi({ map, meter: { num: 4, den: 4 }, dur: 6, mode: 'pins', trimmed: true, pitched });
    const back = readMidi(bytes);
    expect(back.map((n) => [n.pitch, n.vel])).toEqual([[40, 100], [43, 90], [45, 80]]);
    back.forEach((n, i) => {
      expect(n.t).toBeCloseTo(pitched[i].t, 2);
      expect(n.end).toBeCloseTo(pitched[i].end, 2);
    });
  });

  it('matches each note once, within 50 ms and on its pitch', () => {
    const truth = [{ pitch: 60, t: 1, end: 2 }, { pitch: 64, t: 1, end: 2 }, { pitch: 60, t: 3, end: 3.2 }];
    const found = [{ pitch: 60, t: 1.02, end: 2.1 }, { pitch: 60, t: 1.03, end: 2 }, { pitch: 65, t: 1, end: 2 }, { pitch: 60, t: 3.01, end: 3.5 }];
    const s = score(truth, found);
    expect([s.matched, s.matchedEnds]).toEqual([2, 1]);
    expect(prf(s).p).toBeCloseTo(0.5);
    expect(prf(s).r).toBeCloseTo(2 / 3);
  });
});
