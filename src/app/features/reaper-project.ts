// Everything in one REAPER project: the audio as it is heard (warped onto the grid when the Warped switch
// is on, the original otherwise), the tempo map that goes with it, and the drums and the notes found,
// each on a MIDI track of its own, lined up with the audio. One .zip holds the .rpp and the audio.
import { fmtBpm, plural, safeName } from '../../core/format';
import { saveError, saveFile } from '../../io/download';
import { buildRpp } from '../../io/formats/rpp';
import { wavEncode } from '../../io/formats/wav';
import { type ZipEntry, zipFiles } from '../../io/formats/zip';
import type { App } from '../app';
import type { Beats } from './beats';
import type { Exports } from './exports';
import type { Groove } from './groove';
import type { Notes } from './notes';
import type { Warp } from './warp';

export class ReaperProject {
  constructor(
    private readonly app: App,
    private readonly beats: Beats,
    private readonly exports: Exports,
    private readonly warp: Warp,
    private readonly groove: Groove,
    private readonly notes: Notes,
  ) {}

  /** What the project will hold, in a line, or why there is nothing to save yet. */
  contents(): { text: string; ok: boolean } {
    const { app } = this, out = app.warpOut;
    if (!app.audio) return { text: 'Open an audio file first.', ok: false };
    if (!app.hasMap) return { text: 'Set bar 1 and at least a tempo in step 2 first.', ok: false };
    const drums = this.groove.drumNotes()?.length ?? 0, notes = this.notes.pitchedNotes()?.length ?? 0;
    const parts = [
      out ? `The audio warped to ${fmtBpm(out.plan.bpm)} BPM${out.plan.loop ? ' (the loop)' : ''}, on its steady grid` : 'The original audio on the tempo map',
      drums ? `drums: ${plural(drums, 'note')}` : 'no drums yet (find them in Groove)',
      notes ? `notes: ${plural(notes, 'note')}` : 'no notes yet (find them in Notes)',
    ];
    return { text: parts.join(' · ') + '.', ok: true };
  }

  async save(): Promise<void> {
    const { app } = this, a = app.audio;
    if (!a) return app.notify.toast('Open an audio file first.');
    this.beats.ensureDownbeat();
    if (!app.hasMap) return app.notify.toast('Nothing to export yet – map the beats in step 2.');
    const base = safeName(a.name || 'audio') + '-project', files: ZipEntry[] = [];
    let audioName: string;
    try {
      const out = app.warpOut;
      if (out) {
        // The warped file is made here, as the Warp step saves it; the notes are placed on the same warp.
        const w = await this.warp.wav();
        if (!w || app.warpOut?.plan !== w.plan) return app.notify.toast('The audio changed while it was warping – save again.');
        audioName = this.warp.fileName(w.plan);
        files.push({ name: audioName, data: w.bytes });
      } else {
        app.notify.toast('Packing the audio…');
        await new Promise((r) => setTimeout(r, 30));
        audioName = a.fileName;
        files.push({ name: audioName, data: a.file ? new Uint8Array(await a.file.arrayBuffer()) : wavEncode([a.x], a.sr) });
      }
    } catch (e) {
      console.error(e);
      app.notify.idle();
      return app.notify.toast("Couldn't make the audio for the project – loop a shorter part and try again.");
    }
    const drums = this.groove.drumNotes() ?? [], pitched = this.notes.pitchedNotes() ?? [];
    let text: string;
    try {
      text = buildRpp({ ...this.exports.options(app.warpOut), clicks: false, notes: drums, pitched, fileName: audioName, trackName: a.name }).text;
    } catch (e) {
      console.error(e);
      return app.notify.toast('Nothing to export yet – map the beats in step 2.');
    }
    files.unshift({ name: base + '.rpp', data: new TextEncoder().encode(text) });
    const r = await saveFile(base + '-reaper.zip', zipFiles(files) as BlobPart, 'application/zip');
    if (!r.ok) return app.notify.toast(saveError(r.code, 'Too large for this viewer. Loop a shorter part, or use 16-bit mono.'));
    const tracks = 1 + (drums.length ? 1 : 0) + (pitched.length ? 1 : 0);
    app.notify.toast(`Saved: ${plural(tracks, 'track')} and the tempo map. Unzip, then open the .rpp in REAPER.`);
  }
}
