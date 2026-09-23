// Drum hits edited by hand, as pure functions.
import { describe, expect, it } from 'vitest';
import { applyHitEdits, loudnessAt, noHitEdits } from '../src/core/drums/edit';
import type { DrumHit, PerVoice } from '../src/core/drums/voices';

const hit = (t: number, a = 0.5): DrumHit => ({ t, s: 0.8, a });
const kit = (): PerVoice<DrumHit[]> => ({ kick: [hit(0), hit(1)], snare: [hit(0.5), hit(1.5)], hat: [] });

describe('hit edits', () => {
  it('leave the hits as found when there are none', () => {
    expect(applyHitEdits(kit(), noHitEdits())).toEqual(kit());
  });

  it('delete by voice and time, and add placed hits in time order', () => {
    const out = applyHitEdits(kit(), {
      manual: [{ id: 1, voice: 'kick', t: 0.75, a: 0.3 }, { id: 2, voice: 'hat', t: 0.25, a: 0.1 }],
      removed: [{ voice: 'kick', t: 1 }, { voice: 'snare', t: 1 }],
      nextId: 3,
    });
    expect(out.kick).toEqual([hit(0), { t: 0.75, s: 1, a: 0.3, id: 1 }]);
    expect(out.snare).toEqual(kit().snare);
    expect(out.hat).toEqual([{ t: 0.25, s: 1, a: 0.1, id: 2 }]);
  });

  it('take a placed hit\'s loudness from the audio, else the usual loudness of the voice', () => {
    const all = [hit(0, 0.9), hit(0.02, 0.05), hit(1, 0.4)], kept = [hit(0, 0.9), hit(1, 0.4), hit(2, 0.6)];
    expect(loudnessAt(all, kept, 0.015)).toBe(0.05);
    expect(loudnessAt(all, kept, 0.5)).toBe(0.6);
    expect(loudnessAt([], [], 0.5)).toBe(1);
  });
});
