// The app and its features end to end, without a browser: demo audio in, the same numbers the UI
// shows out. Playback is the only part not covered (it needs Web Audio).
import { beforeEach, describe, expect, it } from 'vitest';
import { buildMidi } from '../src/io/formats/midi';
import { MemoryStore, type TestApp, createTestApp, openDemo } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = createTestApp();
  await openDemo(t);
});

describe('opening audio', () => {
  it('analyses it and finds the transients', () => {
    expect(t.app.markers.length).toBe(128);
    expect(t.app.doc.tempo.baseBpm).toBe(96.5);
    expect(t.app.step).toBe(1);
    expect(t.app.view.range).toEqual({ a: 0, b: t.app.dur });
  });

  it('follows the detection settings', async () => {
    t.f.markers.setSensitivity(20);
    expect(t.app.markers.length).toBeLessThan(128);
    // the same settings the browser comparison ran with, and the count both apps showed there
    t.f.markers.setSensitivity(70);
    t.f.markers.setGap(120);
    await t.f.markers.setAlgo('complex');
    await t.f.markers.setBand('low');
    expect(t.app.markers.length).toBe(106);
  });
});

describe('markers', () => {
  it('adds, deletes, undoes and redoes', () => {
    const { app, f } = t, n = app.markers.length;
    f.markers.add(20.0123);
    expect(app.markers.length).toBe(n + 1);
    expect(app.selectedMarker()?.manual).toBe(true);
    f.markers.remove(app.markers[5]);
    expect(app.markers.length).toBe(n);
    expect(app.undo()).toBe(true);
    expect(app.markers.length).toBe(n + 1);
    expect(app.undo()).toBe(true);
    expect(app.markers.length).toBe(n);
    expect(app.redo()).toBe(true);
    expect(app.markers.length).toBe(n + 1);
  });

  it('refuses a marker right on top of another', () => {
    const { app, f } = t, n = app.markers.length;
    f.markers.add(app.markers[3].t + 0.001);
    expect(app.markers.length).toBe(n);
  });

  it('drags a detected marker as one undo step', () => {
    const { app, f } = t, m = app.markers[10], n = app.markers.length;
    app.checkpoint();
    const id = f.markers.toManual(m);
    f.markers.moveTo(id, m.t + 0.05);
    f.markers.moveTo(id, m.t + 0.03);
    f.markers.settle();
    expect(app.markers.length).toBe(n);
    expect(app.markers.find((k) => k.id === id)?.t).toBeCloseTo(m.t + 0.03);
    app.undo();
    expect(app.markers.find((k) => k.t === m.t)?.manual).toBe(false);
  });

  it('discards manual edits', () => {
    const { app, f } = t, n = app.markers.length;
    f.markers.remove(app.markers[0]);
    f.markers.add(30.5);
    f.markers.reset();
    expect(app.markers.length).toBe(n);
    expect(app.markers.every((m) => !m.manual)).toBe(true);
  });
});

describe('beats', () => {
  it('sets bar 1 on the first transient when entering Beats, and auto-maps', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    expect(app.doc.tempo.anchors).toEqual([{ q: 0, t: app.markers[0].t, manual: true }]);
    expect(t.toasts).toContain('Bar 1 set on the first transient');
    f.beats.autoMap();
    expect(app.doc.tempo.anchors.length).toBe(64);
    expect(app.bars.length).toBe(17);
    app.undo();
    expect(app.doc.tempo.anchors.length).toBe(1);
  });

  it('pins, refuses crossing pins, and unpins', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    const p = f.beats.pinAt(5.0);
    expect(p?.manual).toBe(true);
    expect(f.beats.pinAt(0.1)).toBeNull();
    expect(t.toasts.at(-1)).toMatch(/before bar 1/);
    f.beats.unpin(app.doc.tempo.anchors[0]);
    expect(t.toasts.at(-1)).toMatch(/Bar 1 stays pinned/);
    f.beats.unpin(p!);
    expect(app.doc.tempo.anchors.length).toBe(1);
  });

  it('derives the map from a loop', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.playback.setLoop({ a: 2.909, b: 7.876 }, true);
    f.beats.deriveFromLoop();
    expect(t.toasts.at(-1)).toMatch(/BPM · loop taken as 2 bars · \d+ pins/);
    expect(app.doc.tempo.baseBpm).toBeGreaterThan(90);
    expect(app.doc.tempo.anchors[0].q).toBe(0);
  });

  it('halves and doubles the tempo', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.beats.scaleTempo(0.5);
    expect(app.doc.tempo.baseBpm).toBe(48.25);
    expect(app.bars.length).toBe(9);
    f.beats.scaleTempo(2);
    expect(app.bars.length).toBe(17);
  });

  it('changes the meter as an undoable edit', () => {
    const { app, f } = t;
    f.beats.setMeter({ num: 3 });
    expect(app.grid.barQ).toBe(3);
    app.undo();
    expect(app.grid.barQ).toBe(4);
  });
});

describe('slices', () => {
  it('slices at every marker, inside the loop when it is on', () => {
    const { app, f } = t;
    expect(app.slices.length).toBe(app.markers.length);
    f.playback.setLoop({ a: 2, b: 7 }, true);
    expect(app.slices.length).toBeLessThan(20);
    expect(app.slices.every((s) => s.t0 >= 2 && s.t0 < 7)).toBe(true);
  });

  it('drops and keeps slices by their start time', () => {
    const { app, f } = t;
    f.slicer.toggle(3);
    expect(app.slices[3].off).toBe(true);
    // still dropped after the slices are re-planned
    f.slicer.update({ tail: 20 });
    expect(app.slices[3].off).toBe(true);
    f.slicer.keepAll();
    expect(app.slices.some((s) => s.off)).toBe(false);
  });

  it('remembers the selected slice across a re-plan', () => {
    const { app, f } = t;
    f.slicer.select(7);
    f.slicer.update({ mode: 'fixed' });
    expect(app.sliceIndex).toBe(7);
  });
});

describe('export', () => {
  it('writes the MIDI the map describes', () => {
    const { f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    const { info } = buildMidi(f.exports.options());
    // one tempo per pin, less the two neighbouring beats that land on the same microsecond value
    expect(info.count).toBe(63);
    expect(info.leadBars).toBe(1);
  });
});

describe('sessions', () => {
  it('saves the work to the browser and picks it up when the same audio is opened again', async () => {
    const store = new MemoryStore();
    const a = createTestApp(store);
    await openDemo(a);
    a.f.markers.add(12.3456);
    a.f.markers.remove(a.app.markers[2]);
    a.f.workflow.goTo(2);
    a.f.beats.autoMap();
    a.f.slicer.toggle(4);
    a.f.markers.setSensitivity(61);
    a.f.sessions.autosave();
    expect([...store.map.keys()]).toEqual(['beatmapper:s:drifting-drum-loop.wav|40220', 'beatmapper:index']);

    const b = createTestApp(store);
    await openDemo(b);
    expect(b.toasts.at(-1)).toBe('Picked up where you left off');
    expect(b.app.markers.map((m) => [m.t, m.manual])).toEqual(a.app.markers.map((m) => [m.t, m.manual]));
    expect(b.app.doc.tempo).toEqual(a.app.doc.tempo);
    expect(b.app.detection.sens).toBe(61);
    expect(b.app.step).toBe(2);
    expect(b.app.excluded).toEqual(a.app.excluded);
    // nothing to undo right after a restore
    expect(b.app.undo()).toBe(false);
  });

  it('keeps sessions for the last eight files only', () => {
    const store = new MemoryStore();
    for (let i = 0; i < 10; i++) store.setItem('beatmapper:s:f' + i, '{}');
    store.setItem('beatmapper:index', JSON.stringify(Array.from({ length: 10 }, (_, i) => 'beatmapper:s:f' + i)));
    const a = createTestApp(store);
    return openDemo(a).then(() => {
      a.f.markers.add(3.3);
      a.f.sessions.autosave();
      const idx = JSON.parse(store.getItem('beatmapper:index')!);
      expect(idx.length).toBe(8);
      expect(idx[0]).toBe('beatmapper:s:drifting-drum-loop.wav|40220');
      expect(store.getItem('beatmapper:s:f9')).toBeNull();
    });
  });
});

describe('groove', () => {
  it('finds the demo loop\'s kick, snare and hats and measures their pocket', async () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    expect(app.step).toBe(5);
    const h = app.drumHits!;
    // 16 bars: kick on 1 and 3, snare on 2 and 4, hats on every eighth. The demo's hats are quiet
    // and those on the beat are buried under the kick and snare; the off-beat ones must all be there.
    expect(h.kick.length).toBe(32);
    expect(h.snare.length).toBe(32);
    expect(h.hat.length).toBeGreaterThanOrEqual(64);
    const g = app.pocket!;
    expect(g.bars).toBe(16);
    expect(g.ref).toBe('hat');
    // The demo plays every voice on the beat; only its off-beat hats wander (±4 ms).
    for (const v of g.voices) expect(Math.abs(v.median), v.voice).toBeLessThan(1.5);
    expect(f.groove.summary()).toMatch(/^16 bars · 9\d\.\d BPM/);
  });

  it('follows the settings', async () => {
    const { app, f } = t;
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    const n = app.drumHits!.hat.length;
    f.groove.setSensitivity('hat', 0);
    expect(app.drumHits!.hat.length).toBeLessThan(n);
    f.groove.setGrid('8');
    expect(app.pocket!.stepsPerBar).toBe(8);
    f.groove.setReference('grid');
    expect(app.pocket!.ref).toBe('grid');
    f.playback.setLoop({ a: app.tempoMap.posToTime(8), b: app.tempoMap.posToTime(16) }, true);
    expect(app.pocket!.bars).toBe(2);
  });
});
