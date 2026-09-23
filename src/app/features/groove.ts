// Step 5: the groove. Kick, snare and hats found in the audio, and where each sits against the beat.
import type { Analyzer } from '../../analysis/analyzer';
import type { DrumSource } from '../../core/drums/detect';
import { GM_NOTE, VOICES, type Voice } from '../../core/drums/voices';
import { safeName } from '../../core/format';
import { type GrooveGrid, type Reference, describeGroove } from '../../core/groove/pocket';
import { hasBridge, saveError, saveFile } from '../../io/download';
import { grooveJson } from '../../io/formats/groove';
import { type DrumNote, buildMidi } from '../../io/formats/midi';
import { zipFiles } from '../../io/formats/zip';
import type { App } from '../app';
import { GROOVE_LISTENS, type GrooveChartMode, type GrooveListen } from '../../state/settings';
import type { Exports } from './exports';

const LISTEN_TOAST: Record<GrooveListen, string> = { audio: 'Hear: the audio', midi: 'Hear: the drums as MIDI, on a synth kit', both: 'Hear: the audio and the MIDI drums' };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class Groove {
  private running: Promise<void> | null = null;

  constructor(private readonly app: App, private readonly analyzer: Analyzer, private readonly exports: Exports) {}

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
  setReference(ref: Reference | 'auto'): void { this.app.set('groove', { ref }); }
  toggleExaggerate(): void { this.app.set('groove', { exaggerate: !this.app.groove.exaggerate }); }
  setChart(chart: GrooveChartMode): void { this.app.set('groove', { chart }); }
  toggleChart(): void { this.setChart(this.app.groove.chart === 'pocket' ? 'midi' : 'pocket'); }

  /** What play sounds like here: the audio, the drums found in it on a synth kit, or both. */
  setListen(listen: GrooveListen): void {
    this.app.set('groove', { listen });
    if (listen !== 'audio' && !this.app.drums) this.app.notify.toast('The kit plays the drums once they are found.');
  }

  cycleListen(): void {
    const i = GROOVE_LISTENS.indexOf(this.app.groove.listen), next = GROOVE_LISTENS[(i + 1) % GROOVE_LISTENS.length];
    this.setListen(next);
    this.app.notify.toast(LISTEN_TOAST[next]);
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

  /** Every hit as a note, where it was played, with the tempo map: the take as MIDI. */
  async saveMidi(): Promise<void> {
    const { app } = this, g = app.pocket;
    if (!app.audio || !g) return app.notify.toast('Nothing to export yet – find the drums and map the beats first.');
    const notes: DrumNote[] = g.hits.map((h) => ({ t: h.t, note: GM_NOTE[h.voice], vel: h.vel }));
    let bytes: Uint8Array;
    try { bytes = buildMidi({ ...this.exports.options(), clicks: false, notes }).bytes; } catch (e) { console.error(e); return app.notify.toast('Nothing to export yet – map the beats first.'); }
    const base = this.base() + '-drums';
    if (await hasBridge()) {
      const r = await saveFile(base + '.zip', zipFiles([{ name: base + '.mid', data: bytes }]) as BlobPart, 'application/zip');
      return app.notify.toast(r.ok ? 'Saved. Unzip it to get the .mid file.' : saveError(r.code, "This viewer couldn't save the file."));
    }
    await saveFile(base + '.mid', bytes as BlobPart, 'audio/midi');
    app.notify.toast(`Drum MIDI saved: ${notes.length} notes on ${VOICES.filter((v) => g.hits.some((h) => h.voice === v)).length} voices.`);
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
