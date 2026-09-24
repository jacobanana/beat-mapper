// Step 5: the groove. Kick, snare and hats found in the audio, and where each sits against the beat.
import type { Analyzer } from '../../analysis/analyzer';
import type { DrumSource } from '../../core/drums/detect';
import { loudnessAt } from '../../core/drums/edit';
import { GM_NOTE, VOICES, type Voice } from '../../core/drums/voices';
import { safeName } from '../../core/format';
import { type GrooveGrid, describeGroove, quantizedTime } from '../../core/groove/pocket';
import { nearest } from '../../core/search';
import { hasBridge, saveError, saveFile } from '../../io/download';
import { grooveJson } from '../../io/formats/groove';
import { type DrumNote, buildMidi } from '../../io/formats/midi';
import { zipFiles } from '../../io/formats/zip';
import type { App } from '../app';
import { type GrooveChartMode, defaultGroove } from '../../state/settings';
import { withHits } from '../../state/project';
import type { Exports } from './exports';
import type { Playback } from './playback';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** A drummer can't play one drum twice in 30 ms: a hit placed that close to another is the same hit. */
const SAME_HIT = 0.03;

export class Groove {
  private running: Promise<void> | null = null;

  constructor(private readonly app: App, private readonly analyzer: Analyzer, private readonly exports: Exports, private readonly playback: Playback) {}

  /** Finds the drum hits unless they are already found for this audio and source. */
  ensureDrums(): Promise<void> {
    const { app } = this;
    if (!app.audio || (app.drums && app.drums.source === app.groove.source)) return Promise.resolve();
    return (this.running ??= this.detect().finally(() => { this.running = null; }));
  }

  private async detect(): Promise<void> {
    const { app } = this, audio = app.audio, source = app.groove.source;
    app.busy = true;
    app.notify.busy('Finding kick, snare and hats', 0.02);
    try {
      const drums = await this.analyzer.drums(source, (f) => app.notify.busy('Finding kick, snare and hats', 0.02 + 0.96 * f));
      if (app.audio !== audio) return; // another file was opened meanwhile
      app.drums = drums;
      app.bus.emit('drums', 'groove');
      if (app.doc.tempo.anchors.length < 2) {
        app.notify.toast('The grid is one steady tempo from bar 1. Auto-map the beats (step 2) if the take drifts.');
      }
    } catch (e) {
      console.error(e);
      app.notify.toast("Couldn't find the drums in this audio.");
    } finally {
      app.busy = false;
      app.notify.idle();
    }
    // The source may have changed while this ran.
    if (app.audio === audio && app.groove.source !== source) await this.detect();
  }

  // ---------- settings ----------
  async setSource(source: DrumSource): Promise<void> {
    this.app.set('groove', { source });
    if (source === 'mix') this.app.notify.toast('Full mix: experimental. The other instruments are modelled apart from the drums, but expect misses.');
    await this.ensureDrums();
  }

  setSensitivity(voice: Voice, sens: number): void {
    this.app.set('groove', { sens: { ...this.app.groove.sens, [voice]: clamp(Math.round(sens), 0, 100) } });
  }

  setGrid(grid: GrooveGrid): void { this.app.set('groove', { grid }); }
  toggleExaggerate(): void { this.app.set('groove', { exaggerate: !this.app.groove.exaggerate }); }
  setChart(chart: GrooveChartMode): void { this.app.set('groove', { chart }); }
  /** Moves the drums heard, charted and exported `pct` percent of the way onto the grid. */
  setQuantize(pct: number): void { this.app.set('groove', { quantize: clamp(Math.round(pct), 0, 100) }); }
  toggleChart(): void { this.setChart(this.app.groove.chart === 'pocket' ? 'midi' : 'pocket'); }

  // ---------- editing hits ----------
  /**
   * The transient marker closest to t within `within` seconds, or t itself. Hits placed by hand land
   * on the transients, since those are timed on the audio to the sample.
   */
  alignToTransient(t: number, within: number): number {
    const m = nearest(this.app.markers, t);
    return m && Math.abs(m.t - t) <= within ? m.t : t;
  }

  selectHit(voice: Voice, t: number, move = true): void {
    this.app.select({ kind: 'hit', voice, t });
    if (move) { this.playback.seek(t); this.app.reveal(t); }
  }

  /** Adds a hit of `voice` at t, unless the voice already has one within 30 ms (that one is selected). */
  addHit(voice: Voice, t: number): void {
    const { app } = this, hits = app.drumHits;
    if (!app.audio || !hits || !app.drums) return;
    t = clamp(t, 0, app.dur);
    const near = nearest(hits[voice], t);
    if (near && Math.abs(near.t - t) < SAME_HIT) return this.selectHit(voice, near.t, false);
    const a = loudnessAt(app.drums.hits[voice], app.detectedHits![voice], t);
    app.edit((d) => withHits(d, { manual: [...d.drums.manual, { id: d.drums.nextId, voice, t, a }], nextId: d.drums.nextId + 1 }));
    this.selectHit(voice, t, false);
  }

  removeHit(voice: Voice, t: number): void {
    this.app.edit((d) => {
      const m = d.drums.manual.find((k) => k.voice === voice && k.t === t);
      return m ? withHits(d, { manual: d.drums.manual.filter((k) => k !== m) }) : withHits(d, { removed: [...d.drums.removed, { voice, t }] });
    });
    this.app.select(null);
  }

  removeSelected(): void {
    const h = this.app.selectedHit();
    if (h) this.removeHit(h.voice, h.t);
    else this.app.notify.toast('Select a hit first.');
  }

  /** Discards every edit to the hits: placed ones go, deleted ones come back. */
  resetHits(): void {
    const e = this.app.doc.drums;
    if (!e.manual.length && !e.removed.length) return;
    this.app.edit((d) => withHits(d, { manual: [], removed: [] }));
    this.app.select(null);
  }

  /** Something in this step differs from how it starts: a hit edited, or a sensitivity or measure changed. */
  get changed(): boolean {
    const { app } = this, g = app.groove, g0 = defaultGroove(), e = app.doc.drums;
    return !!app.audio && (e.manual.length > 0 || e.removed.length > 0 || g.grid !== g0.grid || g.quantize !== g0.quantize || VOICES.some((v) => g.sens[v] !== g0.sens[v]));
  }

  /**
   * Starts the step again: the hits as found at the starting sensitivities, measured as they start.
   * The source stays, since changing it means finding the drums again. One undo step brings the edits back.
   */
  reset(): void {
    const { app } = this;
    if (!this.changed) return;
    this.resetHits();
    const { sens, grid, quantize } = defaultGroove();
    app.set('groove', { sens, grid, quantize });
    app.select(null);
    app.notify.toast('Groove reset: the hits as found. Undo brings your hit edits back.');
  }

  /**
   * Turns a detected hit into a placed one at the same time, so it can be moved (the detected one is
   * deleted). Returns the placed hit's id. Not recorded for undo: the caller has already checkpointed.
   */
  toManual(voice: Voice, t: number): number {
    const { app } = this, cur = app.doc.drums.manual.find((k) => k.voice === voice && k.t === t);
    if (cur) return cur.id;
    const a = app.drumHits?.[voice].find((h) => h.t === t)?.a ?? 1, id = app.doc.drums.nextId;
    app.edit((d) => withHits(d, { removed: [...d.drums.removed, { voice, t }], manual: [...d.drums.manual, { id, voice, t, a }], nextId: id + 1 }), false);
    return id;
  }

  /** Moves a placed hit while dragging (not recorded; the drag checkpointed at its start). Returns where it went. */
  moveHitTo(id: number, t: number): number {
    t = clamp(t, 0, this.app.dur);
    this.app.edit((d) => withHits(d, { manual: d.drums.manual.map((k) => (k.id === id ? { ...k, t } : k)) }), false);
    const k = this.app.doc.drums.manual.find((m) => m.id === id);
    if (k) this.app.select({ kind: 'hit', voice: k.voice, t: k.t });
    return t;
  }

  /** ← → with a hit selected: moves it by dt seconds. */
  nudgeSelected(dt: number): void {
    const { app } = this, h = app.selectedHit();
    if (!h) return;
    app.checkpoint();
    const t = this.moveHitTo(this.toManual(h.voice, h.t), h.t + dt);
    this.playback.seek(t, true);
  }

  /** One line for the panel: the pocket in words. */
  summary(): string {
    const g = this.app.pocket;
    if (!g) return this.app.drums ? 'Map the beats to see the pocket.' : '';
    const d = describeGroove(g);
    return `${g.bars} bar${g.bars === 1 ? '' : 's'} · ${g.bpm.toFixed(1)} BPM${d ? ' · ' + d : ''}`;
  }

  // ---------- export ----------
  private base(): string { return safeName(this.app.audio?.name || 'audio'); }

  /**
   * Every hit as a note with the tempo map: the take as MIDI, as it is heard here, where it was played
   * or moved onto the grid as far as the quantize says.
   */
  async saveMidi(): Promise<void> {
    const { app } = this, g = app.pocket;
    if (!app.audio || !g) return app.notify.toast('Nothing to export yet – find the drums and map the beats first.');
    const k = app.groove.quantize / 100;
    const notes: DrumNote[] = g.hits.map((h) => ({ t: quantizedTime(h, k), note: GM_NOTE[h.voice], vel: h.vel }));
    let bytes: Uint8Array;
    try { bytes = buildMidi({ ...this.exports.options(), clicks: false, notes }).bytes; } catch (e) { console.error(e); return app.notify.toast('Nothing to export yet – map the beats first.'); }
    const base = this.base() + '-drums';
    if (await hasBridge()) {
      const r = await saveFile(base + '.zip', zipFiles([{ name: base + '.mid', data: bytes }]) as BlobPart, 'application/zip');
      return app.notify.toast(r.ok ? 'Saved. Unzip it to get the .mid file.' : saveError(r.code, "This viewer couldn't save the file."));
    }
    await saveFile(base + '.mid', bytes as BlobPart, 'audio/midi');
    app.notify.toast(`Drum MIDI saved: ${notes.length} notes on ${VOICES.filter((v) => g.hits.some((h) => h.voice === v)).length} voices${k ? `, quantized ${Math.round(k * 100)} %` : ''}.`);
  }

  /** The typical bar as a Pocket Science groove file. */
  async saveGroove(): Promise<void> {
    const { app } = this, g = app.pocket;
    if (!app.audio || !g || !g.hits.length) return app.notify.toast('Nothing to export yet – find the drums and map the beats first.');
    const text = JSON.stringify(grooveJson(g, app.audio.name, describeGroove(g)), null, 1);
    const r = await saveFile(this.base() + '-groove.json', text as BlobPart, 'application/json');
    app.notify.toast(r.ok ? 'Groove saved for Pocket Science.' : saveError(r.code, "This viewer couldn't save the file."));
  }
}
