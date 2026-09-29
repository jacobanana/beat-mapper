// Everything in one REAPER project: the audio, the tempo map, and the drums and notes as MIDI items that
// land where the MIDI files put them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TempoMap } from '../src/core/tempo/tempo-map';
import { buildRpp } from '../src/io/formats/rpp';
import { createTestApp, openDemo, type TestApp } from './helpers';

const saved: { name: string; data: Uint8Array }[] = [];
vi.mock('../src/io/download', async (orig) => ({
  ...(await orig<typeof import('../src/io/download')>()),
  saveFile: async (name: string, data: BlobPart) => {
    saved.push({ name, data: data as Uint8Array });
    return { ok: true, bridged: false };
  },
  hasBridge: async () => false,
}));

/** Each MIDI item's events, at the ticks they fall on from the project's start. */
function midiItems(text: string): Map<string, { tick: number; bytes: number[] }[]> {
  const out = new Map<string, { tick: number; bytes: number[] }[]>();
  for (const chunk of text.split('  <TRACK').slice(1)) {
    if (!chunk.includes('<SOURCE MIDI')) continue;
    const name = /NAME "([^"]*)"/.exec(chunk)![1], ev: { tick: number; bytes: number[] }[] = [];
    let tick = 0;
    for (const m of chunk.matchAll(/^ +E (\d+) ([0-9a-f ]+)$/gm)) {
      tick += +m[1];
      ev.push({ tick, bytes: m[2].split(' ').map((h) => parseInt(h, 16)) });
    }
    out.set(name, ev);
  }
  return out;
}

describe('the REAPER project', () => {
  // Four beats at 120, then four at 60.
  const map = new TempoMap([{ q: 0, t: 0, manual: true }, { q: 4, t: 2, manual: true }, { q: 8, t: 6, manual: true }], 120);
  const base = { map, meter: { num: 4, den: 4 }, dur: 6, mode: 'pins' as const, trimmed: true, fileName: 'a.wav', now: 0 };

  it('puts the drums and the notes on MIDI tracks of their own, in quarter notes on the tempo map', () => {
    const notes = [{ t: 0.5, note: 36, vel: 100 }, { t: 4, note: 38, vel: 90 }];
    const pitched = [{ t: 1, end: 3, pitch: 40, vel: 80, bend: [{ t: 2, cents: 100 }] }];
    const text = buildRpp({ ...base, notes, pitched }).text;
    expect(text.match(/HASDATA 1 480 QN/g)).toHaveLength(2);
    const items = midiItems(text), drums = items.get('Drums')!, line = items.get('Notes')!;
    // 0.5 s at 120 is a beat in; 4 s is two beats past the change to 60, beat 6.
    expect(drums.filter((e) => e.bytes[0] === 0x99).map((e) => [e.tick, e.bytes[1], e.bytes[2]])).toEqual([[480, 36, 100], [2880, 38, 90]]);
    // The note from beat 2 to beat 5, with its bend (a semitone, half the wheel's way up) at beat 4.
    expect(line.find((e) => e.bytes[0] === 0x90)).toEqual({ tick: 960, bytes: [0x90, 40, 80] });
    expect(line.find((e) => e.bytes[0] === 0x80)!.tick).toBe(2400);
    expect(line.find((e) => e.bytes[0] === 0xe0)).toEqual({ tick: 1920, bytes: [0xe0, 0, 96] });
    // Each ends on an all-notes-off on its own channel.
    expect(drums.at(-1)!.bytes).toEqual([0xb9, 0x7b, 0]);
    expect(line.at(-1)!.bytes).toEqual([0xb0, 0x7b, 0]);
  });

  it('writes no MIDI track when there are no notes', () => {
    expect(buildRpp(base).text).not.toContain('<SOURCE MIDI');
  });
});

describe('saving everything', () => {
  let t: TestApp;
  beforeEach(async () => {
    saved.length = 0;
    t = createTestApp();
    await openDemo(t);
  });
  const rppOf = () => {
    const zip = saved.at(-1)!, text = new TextDecoder('latin1').decode(zip.data);
    return { zip, rpp: text.slice(text.indexOf('<REAPER_PROJECT'), text.indexOf('\n>\n') + 3) };
  };

  it('needs the tempo map, then holds the original audio and the drums found', async () => {
    const { f } = t;
    expect(f.reaper.contents().ok).toBe(false);
    f.workflow.goTo(2);
    f.beats.autoMap();
    expect(f.reaper.contents()).toEqual({ ok: true, text: 'The original audio on the tempo map · no drums yet (find them in Groove) · no notes yet (find them in Notes).' });
    f.workflow.goTo(5);
    await f.groove.ensureDrums();
    const n = f.groove.drumNotes()!.length;
    expect(f.reaper.contents().text).toMatch(new RegExp(`^The original audio on the tempo map · drums: ${n} notes · no notes yet`));
    await f.reaper.save();
    const { zip, rpp } = rppOf();
    expect(zip.name).toBe('drifting-drum-loop-project-reaper.zip');
    expect(rpp).toContain('FILE "drifting-drum-loop.wav"');
    expect(midiItems(rpp).get('Drums')!.filter((e) => e.bytes[0] === 0x99)).toHaveLength(n);
    expect(t.toasts.at(-1)).toMatch(/^Saved: 2 tracks and the tempo map/);
  });

  it('holds the audio warped, on the warped grid, when Warped is on', async () => {
    const { app, f } = t;
    f.workflow.goTo(2);
    f.beats.autoMap();
    f.workflow.goTo(3);
    f.warp.setListen(true);
    f.warp.update({ mode: 'repitch' });
    const bpm = app.warpOut!.plan.bpm;
    expect(f.reaper.contents().text).toMatch(new RegExp(`^The audio warped to ${bpm} BPM, on its steady grid`));
    await f.reaper.save();
    const { zip, rpp } = rppOf();
    const wav = f.warp.fileName(app.warpOut!.plan);
    expect(rpp).toContain(`FILE "${wav}"`);
    // One steady tempo: the warped file's grid.
    expect(rpp).toContain(`TEMPO ${bpm.toFixed(10)} 4 4`);
    expect(new TextDecoder('latin1').decode(zip.data)).toContain(wav);
  });
});
