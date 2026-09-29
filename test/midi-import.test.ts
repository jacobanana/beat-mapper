// A tempo map read back from a MIDI file and laid onto the audio: BeatMapper's own export round-trips,
// and a DAW's file (tempo steps, ramps, a pickup, other meters) lands where it plays.
import { describe, expect, it } from 'vitest';
import { importTempo } from '../src/core/tempo/import';
import { TempoMap } from '../src/core/tempo/tempo-map';
import { buildMidi } from '../src/io/formats/midi';
import { MidiReadError, readMidiTempo } from '../src/io/formats/midi-read';
import { type TestApp, createTestApp, openDemo } from './helpers';

// A type-1 file by hand: ppq 480, one track of meta events, each [tick, bytes].
const vlq = (n: number): number[] => { const b = [n & 127]; while ((n >>= 7) > 0) b.unshift((n & 127) | 128); return b; };
const tempo = (bpm: number) => { const u = Math.round(6e7 / bpm); return [0xff, 0x51, 3, (u >> 16) & 255, (u >> 8) & 255, u & 255]; };
const sig = (num: number, den: number) => [0xff, 0x58, 4, num, Math.log2(den), 24, 8];
function smf(events: [number, number[]][], ppq = 480, extra: number[][] = []): Uint8Array {
  const tracks = [events, ...extra.map((e) => [[0, e]] as [number, number[]][])].map((evs) => {
    const body: number[] = [];
    let last = 0;
    for (const [tick, data] of [...evs].sort((a, b) => a[0] - b[0])) { body.push(...vlq(tick - last), ...data); last = tick; }
    body.push(0, 0xff, 0x2f, 0);
    const n = body.length;
    return [0x4d, 0x54, 0x72, 0x6b, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...body];
  });
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, ppq >> 8, ppq & 255, ...tracks.flat()]);
}

describe('reading a MIDI tempo map', () => {
  it('reads tempo changes and time signatures, stepping over notes and running status', () => {
    const notes = [0x90, 60, 100, 0, 60, 0, 0, 62, 100];
    const r = readMidiTempo(smf([[0, sig(3, 4)], [0, tempo(90)], [960, tempo(120)], [1440, sig(6, 8)], [10, notes]]));
    expect(r.sigs).toEqual([{ q: 0, num: 3, den: 4 }, { q: 3, num: 6, den: 8 }]);
    expect(r.tempos.map((x) => [x.q, +x.bpm.toFixed(3)])).toEqual([[0, 90], [2, 120]]);
  });

  it('says why a file is no use', () => {
    expect(() => readMidiTempo(new TextEncoder().encode('RIFF....WAVE'))).toThrow(MidiReadError);
    const smpte = smf([[0, tempo(100)]]);
    smpte[12] = 0xe7;
    expect(() => readMidiTempo(smpte)).toThrow(/SMPTE/);
  });

  it('keeps what it read of a track cut short', () => {
    const full = smf([[0, tempo(100)], [480, tempo(110)]]);
    expect(readMidiTempo(full.subarray(0, full.length - 6)).tempos.map((x) => Math.round(x.bpm))).toEqual([100]);
  });
});

describe('laying it onto the audio', () => {
  it("round-trips BeatMapper's own export, pin for pin", () => {
    // Bar 1 later than a bar into the take, so the export writes a lead-in with a pickup bar.
    const map = new TempoMap([{ q: 0, t: 0.3, manual: true }, { q: 4, t: 2.3, manual: true }, { q: 8, t: 4.1, manual: true }, { q: 12, t: 6.0, manual: true }], 120);
    const dur = 7;
    for (const trimmed of [false, true]) {
      const { bytes, info } = buildMidi({ map, meter: { num: 4, den: 4 }, dur, mode: 'pins', trimmed });
      const r = importTempo(readMidiTempo(bytes), dur, trimmed ? info.t0 : 0)!;
      expect(r.meter).toEqual({ num: 4, den: 4 });
      const back = new TempoMap(r.anchors, r.baseBpm);
      for (let q = 0; q <= 14; q += 0.5) expect(back.posToTime(q)).toBeCloseTo(map.posToTime(q), 3);
    }
  });

  it('puts a pin on every tempo step and holds the last tempo to the end', () => {
    const r = importTempo(readMidiTempo(smf([[0, tempo(100)], [4 * 480, tempo(125)], [8 * 480, tempo(80)]])), 20)!;
    expect(r.anchors.slice(0, 3).map((a) => [a.q, +a.t.toFixed(6)])).toEqual([[0, 0], [4, 2.4], [8, 4.32]]);
    expect(r.anchors.length).toBe(4);
    const m = new TempoMap(r.anchors, r.baseBpm);
    expect(m.bpmAt(1)).toBeCloseTo(100, 6);
    expect(m.bpmAt(3)).toBeCloseTo(125, 6);
    expect(m.bpmAt(19.9)).toBeCloseTo(80, 6);
    expect(r.anchors.every((a) => a.manual)).toBe(true);
    expect([r.minBpm, r.maxBpm, r.changes, r.baseBpm]).toEqual([80, 125, 3, 100]);
  });

  it('is bar 1 and the starting tempo when the file has one tempo', () => {
    const r = importTempo(readMidiTempo(smf([[0, sig(7, 8)], [0, tempo(141.5)]])), 30)!;
    expect(r.anchors).toEqual([{ q: 0, t: 0, manual: true }]);
    expect(r.baseBpm).toBeCloseTo(141.5, 3);
    expect(r.meter).toEqual({ num: 7, den: 8 });
  });

  it('thins a ramp written a tick apart, each pin on its curve', () => {
    const ev: [number, number[]][] = [];
    for (let k = 0; k <= 16 * 48; k++) ev.push([k * 10, tempo(90 + k * 0.05)]);
    const src = readMidiTempo(smf(ev)), r = importTempo(src, 60)!;
    expect(r.anchors.length).toBeLessThan(80);
    for (let i = 1; i < r.anchors.length; i++) expect(r.anchors[i].q - r.anchors[i - 1].q).toBeGreaterThanOrEqual(0.25 - 1e-9);
    // Each pin sits where the file puts its position: seconds summed tick by tick.
    let t = 0, k = 0;
    for (const a of r.anchors.slice(0, -1)) {
      for (; (k * 10) / 480 < a.q - 1e-9; k++) t += (10 / 480) * (60 / src.tempos[Math.min(k, src.tempos.length - 1)].bpm);
      expect(a.t).toBeCloseTo(t, 6);
    }
  });

  it('starts bar 1 after a pickup bar and says where the meter changes', () => {
    const r = importTempo(readMidiTempo(smf([[0, sig(2, 4)], [0, tempo(120)], [960, sig(4, 4)], [960 + 8 * 1920, sig(3, 4)]])), 60)!;
    expect(r.pickupQ).toBe(2);
    expect(r.anchors[0]).toEqual({ q: 0, t: 1, manual: true });
    expect(r.meter).toEqual({ num: 4, den: 4 });
    expect(r.meterChangeBar).toBe(9);
  });

  it('falls back to 4/4 for a time signature it has no grid for, and to 120 with no tempo', () => {
    const r = importTempo(readMidiTempo(smf([[0, sig(5, 32)]])), 10)!;
    expect(r.meter).toEqual({ num: 4, den: 4 });
    expect(r.meterKept).toBe(true);
    expect(r.baseBpm).toBe(120);
  });

  it('gives up when bar 1 is past the end of the audio', () => {
    expect(importTempo(readMidiTempo(smf([[0, sig(2, 4)], [0, tempo(60)], [960, sig(4, 4)]])), 1.5)).toBeNull();
  });
});

describe('From MIDI in the Beats step', () => {
  let t: TestApp;
  const file = (b: Uint8Array) => new Blob([b.slice().buffer], { type: 'audio/midi' });

  it('replaces the map as one undo step', async () => {
    t = createTestApp();
    await openDemo(t);
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    const before = app.doc.tempo;
    expect(await f.beats.importMidi(file(smf([[0, sig(3, 4)], [0, tempo(100)], [3 * 480, tempo(110)]])), 'song.mid')).toBe(true);
    expect(app.doc.meter).toEqual({ num: 3, den: 4 });
    expect(app.doc.tempo.anchors[0]).toEqual({ q: 0, t: 0, manual: true });
    expect(app.tempoMap.posToTime(3)).toBeCloseTo(1.8, 9);
    expect(app.bars[1].bpm).toBeCloseTo(110, 3);
    expect(t.toasts.at(-1)).toMatch(/^Tempo map from song\.mid: 100\.00–110\.00 BPM · 3\/4 · 3 pins/);
    app.undo();
    expect(app.doc.tempo).toBe(before);
    expect(app.doc.meter).toEqual({ num: 4, den: 4 });
  });

  it('leaves the map alone on a file it cannot read, or with no audio', async () => {
    t = createTestApp();
    expect(await t.f.beats.importMidi(file(smf([[0, tempo(100)]])))).toBe(false);
    expect(t.toasts.at(-1)).toMatch(/Open the audio first/);
    await openDemo(t);
    const before = t.app.doc;
    expect(await t.f.beats.importMidi(new Blob(['not midi']), 'x.mid')).toBe(false);
    expect(t.app.doc).toBe(before);
    expect(t.toasts.at(-1)).toBe('That is not a MIDI file.');
  });
});
