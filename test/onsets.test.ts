// SuperFlux, the detection function for held and pitched notes, against spectral flux on audio whose
// onsets are known exactly: a piano chord held with its strings beating, chords with a soft melody,
// and the drum loop.
import { beforeAll, describe, expect, it } from 'vitest';
import { type Analysis, analyze } from '../src/core/dsp/onset';
import { BandFrames, lasting, pickPeaks, superfluxNow } from '../src/core/dsp/superflux';
import { synthDemo } from '../src/core/demo';
import { detectMarkers, pickCandidates, sensToThr } from '../src/core/markers/detect';
import { synthStrings } from '../src/core/notes/synth';

const SR = 44100, held = synthStrings(SR, true), chords = synthStrings(SR, false), demo = synthDemo(SR);
let anHeld: Analysis, anChords: Analysis, anDemo: Analysis;

beforeAll(async () => {
  [anHeld, anChords, anDemo] = await Promise.all([held.x, chords.x, demo.x].map((x) => analyze(x, SR, { yieldToEventLoop: false })));
}, 60_000);

// The markers the default settings show, and how many of them are within 50 ms of a true onset.
function markers(an: Analysis, x: Float32Array, algo: 'flux' | 'superflux', sens = 55): number[] {
  const c = pickCandidates(an, 'full', x, SR, algo);
  return detectMarkers(c, sensToThr(sens), 0.06).map((i) => c[i].t);
}
function score(found: number[], truth: number[]) {
  const hit = truth.filter((t) => found.some((f) => Math.abs(f - t) < 0.05)).length;
  const extra = found.filter((f) => !truth.some((t) => Math.abs(f - t) < 0.05)).length;
  return { hit, extra };
}

describe('SuperFlux', () => {
  it('marks a held chord and the note over it, not the beating of its strings', () => {
    // Spectral flux reads the beating as dozens of hits; that is what SuperFlux is for.
    expect(score(markers(anHeld, held.x, 'flux'), held.onsets).extra).toBeGreaterThan(20);
    expect(score(markers(anHeld, held.x, 'superflux'), held.onsets)).toEqual({ hit: 2, extra: 0 });
  });

  it('finds chords and the soft melody among them, and nothing else', () => {
    expect(score(markers(anChords, chords.x, 'superflux'), chords.onsets)).toEqual({ hit: chords.onsets.length, extra: 0 });
  });

  it('finds every hit of the drum loop, on the attack', () => {
    const found = markers(anDemo, demo.x, 'superflux');
    expect(score(found, demo.onsets)).toEqual({ hit: demo.onsets.length, extra: 0 });
    const err = demo.onsets.map((t) => Math.min(...found.map((f) => Math.abs(f - t))) * 1000).sort((a, b) => a - b);
    expect(err[err.length >> 1]).toBeLessThan(2);
  });

  it('lets in less of the beating than flux at a high sensitivity too', () => {
    const sf = score(markers(anHeld, held.x, 'superflux', 70), held.onsets), fl = score(markers(anHeld, held.x, 'flux', 70), held.onsets);
    expect(sf.hit).toBe(2);
    expect(sf.extra).toBeLessThan(fl.extra / 3);
  });
});

describe('the pieces', () => {
  it('says a new note lasts and a swell does not', () => {
    const bf = new BandFrames(SR, { N: 2048, ref: 0.3 });
    // The soft note at 3 s, against a moment of the chord ringing on its own.
    expect(lasting(held.x, SR, bf, 3)).toBeGreaterThan(10 * lasting(held.x, SR, bf, 2));
  });

  it('rises where a tone starts, and not where it stops', () => {
    // A tone from 0.5 s, fading out over 50 ms from 1 s; frames every 5 ms, each against the one 15 ms before.
    const x = Float32Array.from({ length: 1.5 * SR }, (_, i) => (i >= 0.5 * SR ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) * Math.min(1, Math.max(0, 1 - (i / SR - 1) / 0.05)) : 0));
    const hop = 220, bf = new BandFrames(SR, { N: 2048, ref: 0.5 });
    const odf = superfluxNow(x, bf, { hop, c0: 0, frames: Math.floor(x.length / hop), lag: 3 }).full;
    const at = (t: number) => Math.max(...odf.slice(Math.round((t - 0.03) * SR / hop), Math.round((t + 0.03) * SR / hop)));
    // A steady tone ripples a little from frame to frame; nothing like a start.
    expect(at(0.5)).toBeGreaterThan(1);
    expect(at(0.75)).toBeLessThan(0.01 * at(0.5));
    expect(at(1)).toBeLessThan(0.01 * at(0.5));
  });

  it('picks peaks over the mean around them', () => {
    const odf = [0, 0, 1, 0, 0, 0, 5, 1, 0, 0, 3, 3, 0];
    expect(pickPeaks(odf, { preMax: 1, postMax: 1, preAvg: 2, postAvg: 2 }).map((p) => p.n)).toEqual([2, 6, 10]);
  });
});
