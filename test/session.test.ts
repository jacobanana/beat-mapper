import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSessionJson, parseSession, toSessionJson } from '../src/io/session';
import { defaultWarp } from '../src/state/settings';

const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-session.json', import.meta.url), 'utf8'));
const fb = { band: 'full' as const, algo: 'flux' as const, baseBpm: 120 };

describe('session files', () => {
  it('reads a file saved by the single-file app and writes it back unchanged', () => {
    const s = parseSession(legacy, legacy.audio.duration, fb);
    expect(s.tempo.anchors.length).toBe(legacy.beats.anchors.length);
    expect(s.step).toBe(3);
    expect(JSON.stringify(toSessionJson(s))).toBe(JSON.stringify(legacy));
  });

  it('carries the Notes step: its settings and deleted notes, only when they differ from how it starts', () => {
    const s = parseSession(legacy, legacy.audio.duration, fb);
    expect(s.notes).toEqual({ mode: 'line', instrument: 'any', sens: 55, legato: false });
    expect(s.removedNotes).toEqual([]);
    expect('notes' in toSessionJson(s)).toBe(false);
    const set = { ...s, step: 6 as const, notes: { mode: 'chords' as const, instrument: 'piano' as const, sens: 70, legato: true }, removedNotes: [{ pitch: 40, t: 1.5 }] };
    const json = toSessionJson(set) as { notes: object };
    expect(json.notes).toEqual({ mode: 'chords', instrument: 'piano', sens: 70, legato: true, removed: [{ pitch: 40, t: 1.5 }] });
    const back = parseSession(JSON.parse(JSON.stringify(json)), legacy.audio.duration, fb);
    expect([back.step, back.notes, back.removedNotes]).toEqual([6, set.notes, set.removedNotes]);
    const odd = parseSession({ ...legacy, notes: { mode: 'drone', instrument: 'kazoo', sens: 400, legato: 'yes', removed: [{ pitch: 300, t: 1 }, { pitch: 40.5, t: 1 }, { pitch: 40, t: -1 }] } }, legacy.audio.duration, fb);
    expect([odd.notes, odd.removedNotes]).toEqual([{ mode: 'line', instrument: 'any', sens: 100, legato: false }, []]);
  });

  it('carries warp markers, and leaves them out when there are none', () => {
    const s = parseSession(legacy, legacy.audio.duration, fb);
    expect(s.warpMarkers).toEqual([]);
    expect('warp' in toSessionJson(s)).toBe(false);
    const withMarkers = { ...s, warpMarkers: [{ t: 1.25, q: 2.5 }, { t: 2, q: 4 }] };
    const back = parseSession(JSON.parse(JSON.stringify(toSessionJson(withMarkers))), legacy.audio.duration, fb);
    expect(back.warpMarkers).toEqual(withMarkers.warpMarkers);
  });

  it('carries the shuffle and the quantize strength, and leaves them out at their defaults', () => {
    const s = parseSession(legacy, legacy.audio.duration, fb);
    expect(s.beats.shuffle).toBe(0);
    expect(s.warp.quantize).toBe(0);
    const set = { ...s, beats: { ...s.beats, shuffle: 60 }, warp: { ...s.warp, quantize: 40 } };
    const json = toSessionJson(set) as { warp: object };
    expect(json.warp).toEqual({ strength: 40 });
    const back = parseSession(JSON.parse(JSON.stringify(json)), legacy.audio.duration, fb);
    expect(back.beats.shuffle).toBe(60);
    expect(back.warp.quantize).toBe(40);
    const odd = parseSession({ ...legacy, beats: { ...legacy.beats, shuffle: 400 }, warp: { strength: 'x' } }, legacy.audio.duration, fb);
    expect([odd.beats.shuffle, odd.warp.quantize]).toEqual([100, 0]);
  });

  it("opens an older file's quantize slider as no quantize: it only set how far the Quantize button went", () => {
    const old = { ...legacy, warp: { markers: [{ t: 2, q: 4 }], quantize: 40 } };
    const s = parseSession(old, legacy.audio.duration, fb);
    expect(s.warp.quantize).toBe(0);
    expect(s.warpMarkers).toEqual([{ t: 2, q: 4 }]);
    expect((toSessionJson(s) as { warp: object }).warp).toEqual({ markers: [{ t: 2, q: 4 }] });
  });

  it('carries the Warp step\'s material, grid tempo, range, switch and gap filling, and leaves them out at their defaults', () => {
    const s = parseSession(legacy, legacy.audio.duration, fb);
    expect(s.warp).toEqual(defaultWarp());
    const set = { ...s, warp: { mode: 'beats' as const, bpm: 96.5, range: 'loop' as const, listen: false, quantize: 0, fill: true } };
    const json = toSessionJson(set) as { warp: object };
    expect(json.warp).toEqual({ mode: 'beats', bpm: 96.5, range: 'loop', listen: false, fill: true });
    expect(parseSession(JSON.parse(JSON.stringify(json)), legacy.audio.duration, fb).warp).toEqual(set.warp);
    const odd = parseSession({ ...legacy, warp: { mode: 'x', bpm: 9000, range: 'y', listen: 'no', fill: 'yes' } }, legacy.audio.duration, fb);
    expect(odd.warp).toEqual({ ...defaultWarp(), bpm: 400 });
  });

  it('carries the drum hits edited by hand, and leaves them out when there are none', () => {
    const s = parseSession(legacy, legacy.audio.duration, fb);
    expect(s.hits).toEqual({ manual: [], removed: [] });
    expect('drums' in toSessionJson(s)).toBe(false);
    const hits = { manual: [{ voice: 'kick' as const, t: 1.5, a: 0.3 }], removed: [{ voice: 'hat' as const, t: 2.25 }] };
    const json = JSON.parse(JSON.stringify(toSessionJson({ ...s, hits })));
    expect(parseSession(json, legacy.audio.duration, fb).hits).toEqual(hits);
    const odd = parseSession({ ...legacy, drums: { manual: [{ voice: 'cowbell', t: 1, a: 1 }, { voice: 'snare', t: -3, a: 1 }, null], removed: 'x' } }, legacy.audio.duration, fb);
    expect(odd.hits).toEqual({ manual: [], removed: [] });
  });

  it('carries the sample rate and the dither of the .wav files, and leaves them out at their defaults', () => {
    const s = parseSession(legacy, legacy.audio.duration, fb);
    expect([s.slicer.rate, s.slicer.dither]).toEqual([null, false]);
    expect(Object.keys((toSessionJson(s) as { slicer: object }).slicer)).toEqual(Object.keys(legacy.slicer));
    const set = { ...s, slicer: { ...s.slicer, rate: 48000, dither: true } };
    const json = toSessionJson(set) as { slicer: Record<string, unknown> };
    expect(Object.keys(json.slicer).slice(-3)).toEqual(['csv', 'rate', 'dither']);
    const back = parseSession(JSON.parse(JSON.stringify(json)), legacy.audio.duration, fb);
    expect([back.slicer.rate, back.slicer.dither]).toEqual([48000, true]);
    const odd = parseSession({ ...legacy, slicer: { ...legacy.slicer, rate: 12345, dither: 'yes' } }, legacy.audio.duration, fb);
    expect([odd.slicer.rate, odd.slicer.dither]).toEqual([null, false]);
  });

  it("still opens a session with the Groove step's old quantize, and saves it without", () => {
    const old = { ...legacy, groove: { quantize: 75 } };
    const s = parseSession(old, legacy.audio.duration, fb);
    expect('groove' in toSessionJson(s)).toBe(false);
    expect(toSessionJson(s)).toEqual(toSessionJson(parseSession(legacy, legacy.audio.duration, fb)));
  });

  it('recognises only BeatMapper sessions', () => {
    expect(isSessionJson(legacy)).toBe(true);
    expect(isSessionJson({ format: 'other' })).toBe(false);
    expect(() => parseSession({}, 10, fb)).toThrow();
  });

  it('clamps, drops and falls back instead of trusting the file', () => {
    const s = parseSession({
      format: 'beatmapper-session', version: 1,
      detection: { sens: 250, gap: 1, band: 'mid', algo: 'magic' },
      markers: { manual: [3, -1, 99, 1, 'x'], removed: [2, NaN] },
      beats: { num: 99.4, den: 5, grid: '64', baseBpm: 'fast', snap: false, anchors: [{ q: 4, t: 3 }, { q: 0, t: 1 }, { q: 2, t: 4 }, { q: 8, t: 50 }] },
      transport: { loop: { a: 5, b: 2 }, loopOn: true, start: 4, playhead: -3 },
      view: { t0: 2, t1: 1 },
      step: 7,
      slicer: { bits: 32, len: 1e9, excluded: [1, 20, 1e6] },
      warp: { markers: [{ t: 2, q: 1 }, { t: 3, q: 0.5 }, { t: 40, q: 9 }, { t: 4, q: 'x' }, null, { t: 5, q: 3 }] },
    }, 10, fb);
    expect(s.detection).toMatchObject({ sens: 100, gap: 10, band: 'full', algo: 'flux' });
    expect(s.markers).toEqual({ manual: [1, 3], removed: [2] });
    expect(s.meter).toEqual({ num: 32, den: 4 });
    expect(s.beats.grid).toBe('16');
    expect(s.beats.snapTo).toBe('off');
    expect(s.tempo.baseBpm).toBe(120);
    // sorted by q; a pin earlier in time than the one before it is dropped, and one past the end
    expect(s.tempo.anchors).toEqual([{ q: 0, t: 1, manual: false }, { q: 2, t: 4, manual: false }]);
    expect(s.transport).toMatchObject({ loop: null, loopOn: false, start: 4, playhead: 4 });
    expect(s.view).toBeNull();
    expect(s.step).toBe(1);
    expect(s.slicer.bits).toBe(24);
    expect(s.slicer.len).toBe(60000);
    expect(s.excluded).toEqual([1]);
    // one that crosses an earlier one, one past the end and a bad one are dropped
    expect(s.warpMarkers).toEqual([{ t: 2, q: 1 }, { t: 5, q: 3 }]);
  });
});
