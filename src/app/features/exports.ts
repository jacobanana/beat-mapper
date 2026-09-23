// Step 3: the tempo map out to a DAW, as a MIDI file or a REAPER project.
import { safeName } from '../../core/format';
import { hasBridge, saveError, saveFile } from '../../io/download';
import { type ExportOptions, buildMidi } from '../../io/formats/midi';
import { buildRpp } from '../../io/formats/rpp';
import { wavEncode } from '../../io/formats/wav';
import { type ZipEntry, zipFiles } from '../../io/formats/zip';
import type { App } from '../app';
import type { Beats } from './beats';

const NOTHING = 'Nothing to export yet – map the beats in step 2.';

export class Exports {
  constructor(private readonly app: App, private readonly beats: Beats) {}

  options(): ExportOptions {
    const { app } = this, e = app.exportSettings;
    return { map: app.tempoMap, meter: app.doc.meter, dur: app.dur, mode: e.res, trimmed: e.lead === 'trim', clicks: e.clicks };
  }

  private base(): string { return safeName(this.app.audio?.name || 'audio') + '-tempo-map'; }

  async saveMidi(): Promise<void> {
    const { app } = this;
    if (!app.audio) return app.notify.toast('Open an audio file first.');
    this.beats.ensureDownbeat();
    let bytes: Uint8Array;
    try { bytes = buildMidi(this.options()).bytes; } catch (e) { console.error(e); return app.notify.toast(NOTHING); }
    const base = this.base();
    // A host bridge may refuse .mid files, so there it goes inside a zip.
    if (await hasBridge()) {
      const r = await saveFile(base + '.zip', zipFiles([{ name: base + '.mid', data: bytes }]) as BlobPart, 'application/zip');
      return app.notify.toast(r.ok ? 'Saved. Unzip it to get the .mid file.' : saveError(r.code, "This viewer couldn't save the file."));
    }
    await saveFile(base + '.mid', bytes as BlobPart, 'audio/midi');
    app.notify.toast('MIDI file saved.');
  }

  async saveRpp(): Promise<void> {
    const { app } = this, a = app.audio;
    if (!a) return app.notify.toast('Open an audio file first.');
    this.beats.ensureDownbeat();
    const withAudio = app.exportSettings.rppAudio;
    let text: string;
    try { text = buildRpp({ ...this.options(), fileName: a.fileName, trackName: a.name }).text; } catch (e) { console.error(e); return app.notify.toast(NOTHING); }
    const base = this.base(), rpp = new TextEncoder().encode(text), files: ZipEntry[] = [{ name: base + '.rpp', data: rpp }];
    if (withAudio) {
      app.notify.toast('Packing the audio…');
      await new Promise((r) => setTimeout(r, 30));
      try {
        files.push({ name: a.fileName, data: a.file ? new Uint8Array(await a.file.arrayBuffer()) : wavEncode([a.x], a.sr) });
      } catch {
        return app.notify.toast("Couldn't read the audio file again. Untick “with the audio file” and copy it next to the .rpp yourself.");
      }
    }
    const zipped = withAudio || (await hasBridge());
    const r = zipped
      ? await saveFile(base + '-reaper.zip', zipFiles(files) as BlobPart, 'application/zip')
      : await saveFile(base + '.rpp', rpp as BlobPart, 'text/plain');
    if (!r.ok) return app.notify.toast(saveError(r.code, 'Too large for this viewer. Untick “with the audio file”.'));
    app.notify.toast(zipped ? 'Saved. Unzip, then open the .rpp in REAPER.' : 'Saved. Put the .rpp in the same folder as ' + a.fileName + '.');
  }
}
