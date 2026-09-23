// The drum detector and the pocket analysis on a synthetic kit whose pocket is known.
import { beforeAll, describe, expect, it } from 'vitest';
import { KIT_POCKET, synthKit } from '../src/core/demo';
import { type DrumAnalysis, detectDrums } from '../src/core/drums/detect';
import { selectHits } from '../src/core/drums/select';
import { VOICES, perVoice } from '../src/core/drums/voices';
import { analyseGroove, describeGroove } from '../src/core/groove/pocket';
import { TempoMap } from '../src/core/tempo/tempo-map';
import { grooveJson, offApprox } from '../src/io/formats/groove';
import { buildMidi } from '../src/io/formats/midi';

const SR = 44100, kit = synthKit(SR);
// The tempo map the kit was played to: a pin on every beat.
const map = new TempoMap(kit.beats.map((t, i) => ({ q: i, t, manual: true })), 92);
const meter = { num: 4, den: 4 };
let an: DrumAnalysis;

beforeAll(async () => {
  an = await detectDrums(kit.x, SR, { yieldToEventLoop: false });
}, 60_000);

describe('drum detection', () => {
  it('finds every hit of every voice, in the right voice, and nothing else', () => {
    const hits = selectHits(an.hits, perVoice(() => 55));
    for (const v of VOICES) {
      const truth = kit.hits.filter((h) => h.voice === v);
      const found = truth.filter((h) => hits[v].some((g) => Math.abs(g.t - h.t) < 0.01));
      const extra = hits[v].filter((g) => !truth.some((h) => Math.abs(g.t - h.t) < 0.01));
      // Hats on the backbeat are buried under the snare's wires; everything else must be found.
      const expected = v === 'hat' ? truth.filter((h) => h.step !== 4 && h.step !== 12).length : truth.length;
      expect(found.length, v).toBeGreaterThanOrEqual(expected);
      expect(extra.length, v).toBe(0);
    }
  });

  it('times the hits to a fraction of a millisecond', () => {
    const hits = selectHits(an.hits, perVoice(() => 55));
    for (const v of VOICES) {
      const err: number[] = [];
      for (const h of kit.hits.filter((k) => k.voice === v)) {
        const g = hits[v].find((x) => Math.abs(x.t - h.t) < 0.01);
        if (g) err.push(Math.abs(g.t - h.t) * 1000);
      }
      err.sort((a, b) => a - b);
      // A backbeat hat, under the snare, can be timed by the snare's attack instead.
      expect(err[Math.floor(err.length * 0.9)], v).toBeLessThan(0.5);
    }
  });
});

describe('pocket', () => {
  it('measures each voice against the hats', () => {
    const g = analyseGroove(selectHits(an.hits, perVoice(() => 55)), { map, meter, grid: '16', ref: 'auto' });
    expect(g.ref).toBe('hat');
    expect(g.bars).toBe(8);
    expect(g.stepsPerBar).toBe(16);
    const at = (v: string, step: number) => g.steps.find((s) => s.voice === v && s.step === step)!;
    // Each hit was scattered ±2 ms and so were the hats the bars are measured from.
    const near = (ms: number, want: number) => expect(Math.abs(ms - want)).toBeLessThan(1.5);
    near(at('kick', 0).ms, KIT_POCKET.kick);
    near(at('kick', 10).ms, KIT_POCKET.kick);
    near(at('snare', 4).ms, KIT_POCKET.snare);
    near(at('snare', 12).ms, KIT_POCKET.snare);
    near(at('snare', 9).ms, KIT_POCKET.ghost);
    near(at('hat', 2).ms, KIT_POCKET.hat);
    expect(at('kick', 7).presence).toBe(1);
    expect(at('snare', 9).vel).toBeLessThan(70);
    expect(at('snare', 4).vel).toBeGreaterThan(100);
    // at 92 BPM a tick is 1.36 ms
    expect(Math.abs(at('snare', 4).ticks - KIT_POCKET.snare / 1.3587)).toBeLessThan(1.5);
    expect(describeGroove(g)).toMatch(/^Against the hats: kick -[56] ms ahead, snare \+\d+ ms behind/);
  });

  it('reads the same pocket off a map pinned to bar 1 only, with the hats keeping time', () => {
    // A single pin: the grid drifts from the real beat, but each bar is re-centred on the hats.
    const one = new TempoMap([{ q: 0, t: kit.beats[0], manual: true }], 92);
    const g = analyseGroove(selectHits(an.hits, perVoice(() => 55)), { map: one, meter, grid: '16', ref: 'hat' });
    const snare = g.steps.find((s) => s.voice === 'snare' && s.step === 4)!;
    expect(Math.abs(snare.ms - KIT_POCKET.snare)).toBeLessThan(2.5);
  });

  it('measures against the grid when asked', () => {
    const g = analyseGroove(selectHits(an.hits, perVoice(() => 55)), { map, meter, grid: '16', ref: 'grid' });
    const hat = g.voices.find((v) => v.voice === 'hat')!;
    expect(Math.abs(hat.median)).toBeLessThan(1);
    expect(hat.swing).toBeNull(); // hats play eighths only: no odd sixteenths to swing
  });

  it('keeps to the range it is given', () => {
    const g = analyseGroove(selectHits(an.hits, perVoice(() => 55)), { map, meter, grid: '16', ref: 'hat', range: { a: map.posToTime(8), b: map.posToTime(16) } });
    expect(g.bars).toBe(2);
  });
});

describe('exports', () => {
  it('writes the typical bar as a Pocket Science pattern', () => {
    const g = analyseGroove(selectHits(an.hits, perVoice(() => 55)), { map, meter, grid: '16', ref: 'hat' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j = grooveJson(g, 'Pocket Demo', describeGroove(g)) as any, p = j.patterns[0];
    expect(j.format).toBe('groove-atlas-v2');
    expect(j.ppq).toBe(480);
    expect(j.note_map).toEqual({ kick: 36, snare: 38, hat: 42 });
    expect(p).toMatchObject({ id: 'pocket_demo', grid: 16, bars: 1, swing_16th: null });
    expect(p.tracks.kick.map((h: { step: number }) => h.step)).toEqual([0, 7, 10]);
    expect(p.tracks.snare.map((h: { step: number }) => h.step)).toEqual([4, 9, 12, 15]);
    const back = p.tracks.snare.find((h: { step: number }) => h.step === 4);
    expect(back.off_ticks).toBeGreaterThan(9);
    expect(back.off_approx).toMatch(/^\+1\//);
    expect(offApprox(-10)).toBe('-1/192');
    expect(offApprox(0)).toBe('0');
  });

  it('writes every hit to MIDI where it was played', () => {
    const g = analyseGroove(selectHits(an.hits, perVoice(() => 55)), { map, meter, grid: '16', ref: 'hat' });
    const notes = g.hits.map((h) => ({ t: h.t, note: 36, vel: h.vel }));
    const bytes = buildMidi({ map, meter, dur: kit.dur, mode: 'pins', trimmed: false, clicks: false, notes }).bytes;
    const plain = buildMidi({ map, meter, dur: kit.dur, mode: 'pins', trimmed: false, clicks: false }).bytes;
    expect(bytes[11]).toBe(2); // tempo track and drums
    expect(plain[11]).toBe(1);
    // the drum track opens with its name and holds a note-on and a note-off per hit
    const drums = Buffer.from(bytes.subarray(plain.length));
    expect(drums.subarray(0, 4).toString('latin1')).toBe('MTrk');
    let on = 0;
    for (let i = 0; i < drums.length - 2; i++) if (drums[i] === 0x99 && drums[i + 1] === 36) on++;
    expect(on).toBe(notes.length);
  });
});

describe('full mix (experimental)', () => {
  // The kit under a plucked bass on the eighths and a chord pad: what the percussive split buys.
  const mix = kit.x.slice(), roots = [55, 55, 65.4, 49];
  for (let i = 0; i < kit.beats.length - 1; i++) for (let h = 0; h < 2; h++) {
    const t0 = kit.beats[i] + (h * (kit.beats[i + 1] - kit.beats[i])) / 2, f = roots[Math.floor(i / 4) % 4] * (h ? 2 : 1);
    for (let n = 0; n < 0.3 * SR; n++) { const s = Math.round(t0 * SR) + n; if (s < mix.length) mix[s] += 0.35 * Math.sin((2 * Math.PI * f * n) / SR) * Math.min(1, n / (0.01 * SR)) * Math.exp(-n / (0.25 * SR)); }
  }
  for (let b = 0; b * 4 < kit.beats.length - 1; b++) {
    const t0 = kit.beats[b * 4], t1 = kit.beats[b * 4 + 4], r = roots[b % 4] * 4;
    for (let n = 0; n < (t1 - t0) * SR; n++) {
      const s = Math.round(t0 * SR) + n;
      let v = 0;
      for (const m of [1, 1.26, 1.5]) for (let k = 1; k <= 8; k++) v += Math.sin((2 * Math.PI * r * m * k * n) / SR) / k;
      mix[s] += 0.04 * v * Math.min(1, n / (0.05 * SR));
    }
  }
  const recall = (hits: ReturnType<typeof selectHits>, v: 'kick' | 'snare' | 'hat') =>
    kit.hits.filter((h) => h.voice === v && hits[v].some((g) => Math.abs(g.t - h.t) < 0.01)).length;

  it('still finds the hats and the kicks under a bass line', async () => {
    const hits = selectHits((await detectDrums(mix, SR, { source: 'mix', yieldToEventLoop: false })).hits, perVoice(() => 55));
    expect(recall(hits, 'hat')).toBe(64);
    expect(recall(hits, 'kick')).toBeGreaterThanOrEqual(22);
    // Known weakness: plucked bass notes pass for kicks, and the pad hides most snares. Source
    // separation is the way past this; until then the mode is marked experimental.
    expect(recall(hits, 'snare')).toBeGreaterThanOrEqual(8);
  }, 60_000);
});
