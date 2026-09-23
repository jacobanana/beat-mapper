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

  it('changes the meter as an undoable edit', () => {
    const { app, f } = t;
    f.beats.setMeter({ num: 3 });
    expect(app.grid.barQ).toBe(3);
    app.undo();
    expect(app.grid.barQ).toBe(4);
  });
});

describe('loop', () => {
  it('loops the whole file when switched on with nothing drawn, and keeps a drawn loop', () => {
    const { app, f } = t;
    f.playback.toggleLoop();
    expect(app.transport.loopOn).toBe(true);
    expect(app.transport.loop).toEqual({ a: 0, b: app.dur });
    f.playback.toggleLoop();
    expect(app.transport.loopOn).toBe(false);
    f.playback.setLoop({ a: 2, b: 4 }, false);
    f.playback.toggleLoop();
    expect(app.transport.loop).toEqual({ a: 2, b: 4 });
    expect(app.transport.loopOn).toBe(true);
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

  it('plans a warp onto a straight grid: the whole file from a bar line, or the loop alone', () => {
    const { app, f } = t;
    expect(f.warp.plan()).toBeNull();
    f.workflow.goTo(2);
    f.beats.autoMap();
    const p = f.warp.plan()!;
    // The demo drifts from 94 to 101 BPM; the grid takes the whole-number tempo it averages.
    expect(p.bpm).toBe(Math.round(p.avgBpm));
    expect(p.ratios[0]).toBeLessThan(1);
    expect(p.ratios[1]).toBeGreaterThan(1);
    // Bar 1 is the pin at the first transient, a bar of silence ahead of it holds the lead-in.
    expect(p.map.dstAt(app.markers[0].t)).toBeCloseTo((4 * 60) / p.bpm, 6);
    expect(f.warp.fileName(p)).toBe(`drifting-drum-loop_warped_${p.bpm}bpm.wav`);

    f.warp.update({ bpm: 100 });
    const b1 = app.tempoMap.posToTime(4), b3 = app.tempoMap.posToTime(12);
    f.playback.setLoop({ a: b1, b: b3 }, false);
    f.playback.toggleLoop();
    // A loop that is on is still not warped on its own until the Warp step says so.
    expect(f.warp.plan()!.loop).toBe(false);
    f.warp.setRange('loop');
    const l = f.warp.plan()!;
    expect(l.loop).toBe(true);
    expect(l.outDur).toBeCloseTo((8 * 60) / 100, 6);
    expect(f.warp.fileName(l)).toBe('drifting-drum-loop_2bars_100bpm_warped.wav');
  });
});

describe('the Warp step', () => {
  it('lines a transient up with the grid by dragging it, as one undo step', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    f.beats.setGrid('8');
    // An off-beat hat, a little loose: dragged onto the eighth nearest where it is let go.
    const hat = app.markers.find((m) => { const q = app.tempoMap.timeToPos(m.t); return Math.abs(q - Math.round(q) - 0.5) < 0.2; })!;
    const q = Math.round(app.tempoMap.timeToPos(hat.t) * 2) / 2, undos = app.history.canUndo;
    f.warp.grab(hat.t);
    f.warp.dragTo(app.tempoMap.posToTime(q) + 0.01);
    expect(app.warpDrag?.q).toBe(q);
    expect(app.doc.warpMarkers).toEqual([]);
    f.warp.drop();
    expect(app.warpDrag).toBeNull();
    expect(app.doc.warpMarkers).toEqual([{ t: hat.t, q }]);
    // Where the warp puts it: exactly on its eighth of the straight grid.
    const p = app.warpPlan!;
    expect(p.map.dstAt(hat.t)).toBeCloseTo(((q - p.q0) * 60) / p.bpm, 9);
    expect(f.warp.summary()).toContain('1 transient lined up');
    expect(f.warp.changed).toBe(true);
    // The tempo map of the Beats step is left as it was.
    expect(app.tempoMap.anchors.some((a) => a.t === hat.t)).toBe(false);
    app.undo();
    expect(app.doc.warpMarkers).toEqual([]);
    expect(app.history.canUndo).toBe(undos);
  });

  it('quantizes, removes and resets warp markers', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    f.beats.setGrid('8');
    f.warp.quantize();
    const n = app.doc.warpMarkers.length;
    expect(n).toBeGreaterThan(100);
    f.warp.remove(app.doc.warpMarkers[3].t);
    expect(app.doc.warpMarkers.length).toBe(n - 1);
    f.warp.snap(app.markers[3].t);
    expect(app.doc.warpMarkers.length).toBe(n);
    f.warp.reset();
    expect(app.doc.warpMarkers).toEqual([]);
    expect(f.warp.changed).toBe(false);
    app.undo();
    expect(app.doc.warpMarkers.length).toBe(n);
  });

  it('plays it warped by default, and renders once until the warp changes', async () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.warp.update({ mode: 'repitch' });
    expect(f.warp.wanted()).toBe(false);
    f.workflow.goTo(3);
    expect(app.warp.listen).toBe(true);
    expect(f.warp.wanted()).toBe(true);
    f.warp.toggleListen();
    expect(f.warp.wanted()).toBe(false);
    f.warp.toggleListen();
    const r = (await f.warp.render())!;
    expect(r.chans[0].length).toBe(Math.round(r.plan.outDur * 44100));
    // Nothing changed: the same render, for listening and for saving.
    expect(await f.warp.render()).toBe(r);
    // A pin moved (in Beats): rendered again.
    f.beats.nudge(app.doc.tempo.anchors[5], 0.01);
    const r2 = (await f.warp.render())!;
    expect(r2).not.toBe(r);
    expect(r2.plan).toBe(app.warpPlan);
    f.workflow.goTo(4);
    expect(f.warp.wanted()).toBe(false);
  });

  it('takes the grid tempo from a looped section and warps the whole file to it', () => {
    const { app, f, toasts } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    f.warp.fromLoop();
    expect(toasts.at(-1)).toMatch(/^Loop the section/);
    // Bars 13 to 17 are the demo's fastest.
    const map = app.tempoMap;
    f.playback.setLoop({ a: map.posToTime(48), b: map.posToTime(64) }, true);
    f.warp.fromLoop();
    const p = f.warp.plan()!;
    expect(p.bpm).toBe(Math.round((16 * 60) / (map.posToTime(64) - map.posToTime(48))));
    expect(p.bpm).toBeGreaterThan(Math.round(p.avgBpm));
    expect(p.loop).toBe(false);
    expect(p.srcDur).toBeCloseTo(app.dur, 6);
    expect(f.warp.summary()).toMatch(new RegExp(`^The file averages .* warped to ${p.bpm} BPM`));
    expect(f.workflow.canReset).toBe(true);
    f.workflow.resetStep();
    expect(app.warp).toEqual({ mode: 'music', bpm: null, range: 'file', listen: true });
  });
});

describe('resetting a step', () => {
  it('starts Transients again, and undo brings the marker edits back', async () => {
    const { app, f } = t, n = app.markers.length;
    expect(f.workflow.canReset).toBe(false);
    f.markers.add(30.5);
    f.markers.setSensitivity(80);
    await f.markers.setAlgo('complex');
    expect(f.workflow.canReset).toBe(true);
    f.workflow.resetStep();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.detection).toMatchObject({ sens: 55, gap: 60, band: 'full', algo: 'flux' });
    expect(app.markers.length).toBe(n);
    expect(f.workflow.canReset).toBe(false);
    app.undo();
    expect(app.markers.some((m) => m.manual)).toBe(true);
  });

  it('starts Beats again from bar 1 on the first transient', () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    expect(f.workflow.canReset).toBe(false);
    const bar1 = app.doc.tempo.anchors;
    f.beats.autoMap();
    f.beats.setMeter({ num: 3 });
    f.beats.setBaseBpm(120);
    expect(f.workflow.canReset).toBe(true);
    f.workflow.resetStep();
    expect(app.doc.tempo).toEqual({ anchors: bar1, baseBpm: 96.5 });
    expect(app.doc.meter).toEqual({ num: 4, den: 4 });
    expect(f.workflow.canReset).toBe(false);
    app.undo();
    expect(app.doc.meter.num).toBe(3);
    expect(app.doc.tempo.anchors.length).toBeGreaterThan(1);
  });

  it('starts Slice again with every slice kept', () => {
    const { app, f } = t;
    f.workflow.goTo(4);
    f.slicer.toggle(3);
    f.slicer.update({ mode: 'fixed', len: 250 });
    expect(f.workflow.canReset).toBe(true);
    f.workflow.resetStep();
    expect(app.excluded).toEqual([]);
    expect(app.slicer).toMatchObject({ mode: 'gap', len: 500 });
    expect(f.workflow.canReset).toBe(false);
  });

  it('starts Groove again with the hits as found', async () => {
    const { app, f } = t;
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    const kicks = app.drumHits!.kick.length;
    f.groove.removeHit('kick', app.drumHits!.kick[0].t);
    f.groove.setSensitivity('snare', 90);
    expect(f.workflow.canReset).toBe(true);
    f.workflow.resetStep();
    expect(app.drumHits!.kick.length).toBe(kicks);
    expect(app.groove.sens.snare).toBe(55);
    expect(f.workflow.canReset).toBe(false);
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

describe('workflow', () => {
  it('opens a session saved in the old Export step in Warp, which came to have its number', () => {
    t.f.workflow.goTo(3);
    expect(t.app.step).toBe(3);
    expect(t.app.hasMap).toBe(true);
  });
});

describe('mixer', () => {
  it('keeps its levels in range, on this device and out of sessions', () => {
    const store = new MemoryStore();
    const a = createTestApp(store);
    expect(a.app.mix).toEqual({ audio: 100, click: 100, drums: 100 });
    a.f.mixer.setLevel('click', 60);
    a.f.mixer.setLevel('drums', 999);
    a.f.mixer.setLevel('audio', -5);
    expect(a.app.mix).toEqual({ audio: 0, click: 60, drums: 150 });
    expect(JSON.parse(store.getItem('beatmapper:mix')!)).toEqual(a.app.mix);
    expect(createTestApp(store).app.mix).toEqual(a.app.mix);
  });

  it('mutes a channel for this visit, keeping its level; the click\'s mute is its on/off', () => {
    const store = new MemoryStore();
    const a = createTestApp(store);
    a.f.mixer.setLevel('audio', 80);
    expect(a.f.mixer.isOn('audio')).toBe(true);
    expect(a.f.mixer.isOn('drums')).toBe(false);
    a.f.mixer.toggleMute('audio');
    expect(a.f.mixer.isOn('audio')).toBe(false);
    expect(a.f.playback.audioLevel).toBe(0);
    expect(a.app.mix.audio).toBe(80);
    a.f.mixer.toggleMute('audio');
    expect(a.f.playback.audioLevel).toBeCloseTo(0.72);
    expect(a.f.mixer.isOn('click')).toBe(false);
    a.f.mixer.toggleMute('click');
    expect(a.app.transport.click).toBe(true);
    a.f.mixer.toggleMute('audio');
    expect(createTestApp(store).f.mixer.isOn('audio')).toBe(true);
  });

  it('falls back to the defaults for anything unreadable it saved', () => {
    const store = new MemoryStore();
    store.setItem('beatmapper:mix', '{"audio":"loud","click":40.4}');
    expect(createTestApp(store).app.mix).toEqual({ audio: 100, click: 40, drums: 100 });
    store.setItem('beatmapper:mix', 'not json');
    expect(createTestApp(store).app.mix).toEqual({ audio: 100, click: 100, drums: 100 });
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

  it('turns the hits into notes to hear, and switches what is heard and charted', async () => {
    const { app, f } = t;
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    const h = app.drumHits!, notes = app.drumNotes;
    expect(notes.length).toBe(h.kick.length + h.snare.length + h.hat.length);
    for (let i = 1; i < notes.length; i++) expect(notes[i].t).toBeGreaterThanOrEqual(notes[i - 1].t);
    // Same velocities as the pocket gives each hit.
    const g = app.pocket!;
    for (const p of g.hits.slice(0, 20)) expect(notes.find((n) => n.voice === p.voice && n.t === p.t)?.vel).toBe(p.vel);
    expect(f.mixer.isOn('drums')).toBe(false);
    f.mixer.toggleMute('drums');
    expect(f.mixer.isOn('drums')).toBe(true);
    f.mixer.toggleMute('drums');
    expect(f.mixer.isOn('drums')).toBe(false);
    f.groove.toggleChart();
    expect(app.groove.chart).toBe('midi');
  });

  it('adds, moves and deletes hits by hand, on the transients, with undo', async () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    const n = app.drumHits!.kick.length, notes = app.drumNotes.length;
    // A kick where the detector heard none, aimed 10 ms off a transient: it lands on the transient.
    const m = app.markers.find((k) => !app.drumHits!.kick.some((h) => Math.abs(h.t - k.t) < 0.05))!;
    f.groove.addHit('kick', f.groove.alignToTransient(m.t + 0.01, 0.03));
    expect(app.drumHits!.kick.length).toBe(n + 1);
    expect(app.selectedHit()).toMatchObject({ voice: 'kick', t: m.t, id: 1 });
    expect(app.drumNotes.length).toBe(notes + 1);
    expect(app.pocket!.hits.some((h) => h.voice === 'kick' && h.t === m.t)).toBe(true);
    // One within 30 ms of it is the same hit.
    f.groove.addHit('kick', m.t + 0.02);
    expect(app.drumHits!.kick.length).toBe(n + 1);
    // Moving a detected hit makes it a placed one; the drag is one undo step.
    const first = app.drumHits!.snare[0];
    app.checkpoint();
    const id = f.groove.toManual('snare', first.t);
    f.groove.moveHitTo(id, first.t + 0.004);
    f.groove.moveHitTo(id, first.t + 0.008);
    expect(app.drumHits!.snare[0]).toMatchObject({ t: first.t + 0.008, id, a: first.a });
    expect(app.selectedHit()?.t).toBe(first.t + 0.008);
    app.undo();
    expect(app.drumHits!.snare[0]).toEqual(first);
    // Deleting a detected hit survives a change of sensitivity.
    const hat = app.drumHits!.hat[3];
    f.groove.removeHit('hat', hat.t);
    expect(app.drumHits!.hat.some((h) => h.t === hat.t)).toBe(false);
    f.groove.setSensitivity('hat', 80);
    expect(app.drumHits!.hat.some((h) => h.t === hat.t)).toBe(false);
    f.groove.resetHits();
    expect(app.drumHits!.hat.some((h) => h.t === hat.t)).toBe(true);
    expect(app.drumHits!.kick.length).toBe(n);
    app.undo();
    expect(app.drumHits!.kick.length).toBe(n + 1);
  });
});
