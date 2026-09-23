import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSessionJson, parseSession, toSessionJson } from '../src/io/session';

const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-session.json', import.meta.url), 'utf8'));
const fb = { band: 'full' as const, algo: 'flux' as const, baseBpm: 120 };

describe('session files', () => {
  it('reads a file saved by the single-file app and writes it back unchanged', () => {
    const s = parseSession(legacy, legacy.audio.duration, fb);
    expect(s.tempo.anchors.length).toBe(legacy.beats.anchors.length);
    expect(s.step).toBe(3);
    expect(JSON.stringify(toSessionJson(s))).toBe(JSON.stringify(legacy));
  });

  it('carries warp markers, and leaves them out when there are none', () => {
    const s = parseSession(legacy, legacy.audio.duration, fb);
    expect(s.warpMarkers).toEqual([]);
    expect('warp' in toSessionJson(s)).toBe(false);
    const withMarkers = { ...s, warpMarkers: [{ t: 1.25, q: 2.5 }, { t: 2, q: 4 }] };
    const back = parseSession(JSON.parse(JSON.stringify(toSessionJson(withMarkers))), legacy.audio.duration, fb);
    expect(back.warpMarkers).toEqual(withMarkers.warpMarkers);
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
    expect(s.slicer.bits).toBe(16);
    expect(s.slicer.len).toBe(60000);
    expect(s.excluded).toEqual([1]);
    // one that crosses an earlier one, one past the end and a bad one are dropped
    expect(s.warpMarkers).toEqual([{ t: 2, q: 1 }, { t: 5, q: 3 }]);
  });
});
