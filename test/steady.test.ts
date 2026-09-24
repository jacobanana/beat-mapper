// Steady from loop: one tempo for a take played to a click, from a loop and the transients. The take
// here is known exactly: every beat at 100 BPM from 0.8 s, played ±5 ms off it, with off-beat hits
// between, and the loop drawn a few milliseconds off its bar lines, as a hand on a phone draws it.
import { describe, expect, it } from 'vitest';
import { steadyFromLoop } from '../src/core/beats/edit';
import { TempoMap } from '../src/core/tempo/tempo-map';
import type { Hit } from '../src/core/beats/track';

const BPM = 100, SPB = 60 / BPM, START = 0.8, BEATS = 400, METER = { num: 4, den: 4 };
// A fixed pseudo-random sequence, so the test is the same every run.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const take: Hit[] = [];
for (let k = 0; k < BEATS; k++) {
  take.push({ t: START + k * SPB + 0.005 * rnd(), s: 0.9 });
  // an off-beat sixteenth, softer, on some beats
  if (k % 3 === 1) take.push({ t: START + (k + 0.75) * SPB + 0.005 * rnd(), s: 0.3 });
}
take.sort((a, b) => a.t - b.t);
const dur = START + BEATS * SPB + 1;
const bar = 4 * SPB;
// Bars 21 to 24, drawn 6 ms late at the start and 7 ms early at the end.
const loop = { a: START + 20 * bar + 0.006, b: START + 24 * bar - 0.007 };

describe('steady from loop', () => {
  it('takes one tempo from the loop and fits it to the take, so it holds to the end', () => {
    const r = steadyFromLoop(take, loop, METER, 4, { downbeat: null, fit: true, dur });
    // The loop alone is 13 ms short over 4 bars: 0.14 BPM fast, which by the end of the take puts the
    // grid a quarter of a second off the beat.
    const byLoop = new TempoMap([{ q: 80, t: loop.a, manual: true }], r.loopBpm);
    expect(Math.abs(byLoop.posToTime(BEATS - 1) - (START + (BEATS - 1) * SPB))).toBeGreaterThan(0.2);
    expect(r.bpm).toBeCloseTo(BPM, 2);
    expect(r.fitted).toBeGreaterThan(BEATS * 0.95);
    // One pin: bar 1, on the first beat played, a whole number of bars before the loop.
    expect(r.anchors).toHaveLength(1);
    expect(r.anchors[0].q).toBe(0);
    expect(Math.abs(r.anchors[0].t - START)).toBeLessThan(0.002);
    expect((r.ref - r.anchors[0].t) / (4 * 60 / r.bpm)).toBeCloseTo(20, 6);
    // Every beat of the take within 2 ms of where the steady map puts it, at the end as at the start.
    const map = new TempoMap(r.anchors, r.bpm);
    for (const k of [0, 100, 250, BEATS - 1]) expect(Math.abs(map.posToTime(k) - (START + k * SPB))).toBeLessThan(0.002);
  });

  it("keeps the loop's tempo when told not to fit, or when there is nothing to fit to", () => {
    const plain = steadyFromLoop(take, loop, METER, 4, { downbeat: null, fit: false, dur });
    expect(plain.bpm).toBeCloseTo(plain.loopBpm, 9);
    expect(plain.fitted).toBe(0);
    expect(plain.ref).toBe(loop.a);
    const bare = steadyFromLoop([], loop, METER, 4, { downbeat: null, fit: true, dur });
    expect(bare.bpm).toBeCloseTo(bare.loopBpm, 9);
    expect(bare.fitted).toBe(0);
  });

  it('puts bar 1 on the bar line nearest where it was, never after the loop or before the file', () => {
    const near = steadyFromLoop(take, loop, METER, 4, { downbeat: START + 5 * bar + 0.3, fit: true, dur });
    expect(Math.abs(near.anchors[0].t - (START + 5 * bar))).toBeLessThan(0.002);
    const late = steadyFromLoop(take, loop, METER, 4, { downbeat: START + 30 * bar, fit: true, dur });
    expect(late.anchors[0].t).toBeCloseTo(late.ref, 9);
    const early = steadyFromLoop(take, loop, METER, 4, { downbeat: -5, fit: true, dur });
    expect(early.anchors[0].t).toBeGreaterThanOrEqual(0);
    expect(early.anchors[0].t).toBeLessThan(bar);
  });

  it('leaves a take not played to a steady tempo to the loop', () => {
    // Speeding up by a third over the take: no single tempo fits it, and the fit must not pretend one does.
    const drift: Hit[] = [];
    for (let k = 0, t = START; k < BEATS; k++, t += SPB / (1 + k / BEATS / 3)) drift.push({ t, s: 1 });
    const L = { a: drift[80].t, b: drift[96].t };
    const r = steadyFromLoop(drift, L, METER, 4, { downbeat: null, fit: true, dur });
    expect(Math.abs(r.bpm / r.loopBpm - 1)).toBeLessThan(0.03);
  });
});
