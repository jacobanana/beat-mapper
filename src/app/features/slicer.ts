// Step 4: cutting the audio into one-shot samples at the transients, and saving them.
import { fmtBpm, plural, safeName } from '../../core/format';
import { loopTag, sliceName, slicesCsv } from '../../core/slices/naming';
import { type RenderOptions, renderSlice, sliceKey } from '../../core/slices/slices';
import { bufferFrom } from '../../engine/audio-context';
import { saveError, saveFile } from '../../io/download';
import { buildRppSlices } from '../../io/formats/rpp';
import { wavEncode, wavSize } from '../../io/formats/wav';
import { type ZipEntry, zipFiles } from '../../io/formats/zip';
import type { SlicerSettings } from '../../state/settings';
import type { App, SliceView } from '../app';
import type { Exports } from './exports';
import type { Playback } from './playback';

const TOO_LARGE = 'Too large for this viewer. Slice a shorter range, or use 16-bit mono.';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export class Slicer {
  constructor(private readonly app: App, private readonly playback: Playback, private readonly exports: Exports) {}

  update(patch: Partial<SlicerSettings>): void { this.app.set('slicer', patch); }

  /** What every rendered slice gets. */
  renderOptions(): RenderOptions {
    const o = this.app.slicer;
    return { fadeIn: o.fadeIn / 1000, fadeOut: o.fadeOut / 1000, mono: o.mono, normalize: o.norm, target: Math.pow(10, o.target / 20) };
  }

  select(i: number): void {
    const sl = this.app.slices[i];
    if (!sl) return;
    this.app.sliceSel = sl.t0;
    this.app.bus.emit('slices');
  }

  /** Tab / Shift+Tab: the next or previous slice, and hear it. */
  tab(dir: 1 | -1): void {
    const S = this.app.slices, cur = this.app.sliceIndex;
    if (!S.length) return this.app.notify.toast('No slices yet.');
    const i = cur == null ? (dir > 0 ? 0 : S.length - 1) : Math.max(0, Math.min(S.length - 1, cur + dir));
    this.playback.seek(S[i].t0, true);
    this.preview(i);
  }

  /** Index of the slice under time t, or -1. */
  at(t: number): number {
    let hit = -1;
    for (const sl of this.app.slices) { if (sl.t0 > t + 1e-9) break; if (t < sl.t1) hit = sl.i; }
    return hit;
  }

  /** Keeps or drops slice i. Dropped slices are remembered by their start time, to the millisecond. */
  toggle(i: number): void {
    const sl = this.app.slices[i];
    if (!sl) return;
    let ex = this.app.excluded;
    if (!sl.off) { ex = [...ex, sl.t0]; if (ex.length > 5000) ex = ex.slice(1); }
    else ex = ex.filter((t) => Math.abs(sliceKey(t) - sliceKey(sl.t0)) > 1);
    this.app.excluded = ex;
    this.app.bus.emit('slices');
  }

  toggleSelected(): void {
    const i = this.app.sliceIndex;
    if (i == null) return this.app.notify.toast('Select a slice first.');
    this.toggle(i);
  }

  keepAll(): void {
    if (!this.app.slices.length) return;
    this.app.excluded = [];
    this.app.bus.emit('slices');
    this.app.notify.toast('All slices kept');
  }

  /** Plays slice i on its own, rendered exactly as it will be written. */
  preview(i: number): void {
    const { app, playback } = this, sl = app.slices[i], a = app.audio;
    if (!sl || !a) return app.notify.toast('No slice to preview.');
    if (playback.playing) playback.stop(true);
    playback.stopPreview();
    const r = renderSlice(a.chans, a.sr, sl.t0, sl.t1, this.renderOptions());
    playback.oneShot.play(bufferFrom(r.chans, a.sr), sl.t0, sl.t1, () => app.setPlayhead(sl.t0, false));
    this.select(i);
    app.reveal(sl.t0);
    app.setPlayhead(sl.t0, false);
  }

  previewSelected(): void { this.preview(this.app.sliceIndex ?? 0); }

  /** Rough size of the zip of every kept slice. */
  zipEstimate(): number {
    const o = this.app.slicer, ch = o.mono ? 1 : (this.app.audio?.chans.length ?? 1);
    let n = 0;
    for (const sl of this.app.slices) if (!sl.off) n += wavSize(Math.round((sl.t1 - sl.t0) * (this.app.audio?.sr ?? 44100)), ch, o.bits) + 180;
    return n;
  }

  private base(): string { return safeName(this.app.audio?.name || 'audio') || 'audio'; }

  // ---------- saving ----------
  private async save(filename: string, data: Uint8Array, mime: string, ok: string): Promise<void> {
    const r = await saveFile(filename, data as BlobPart, mime);
    this.app.notify.toast(r.ok ? ok : saveError(r.code, TOO_LARGE));
  }

  async saveSelectedWav(): Promise<void> {
    const { app } = this, S = app.slices, a = app.audio;
    if (!S.length || !a) return app.notify.toast('No slices yet.');
    const i = app.sliceIndex ?? 0, sl = S[i];
    this.select(i);
    const r = renderSlice(a.chans, a.sr, sl.t0, sl.t1, this.renderOptions());
    await this.save(sliceName(this.base(), i, String(S.length).length, sl, app.slicer.naming), wavEncode(r.chans, a.sr, app.slicer.bits), 'audio/wav', 'Slice ' + (i + 1) + ' saved');
  }

  // The loop itself, untouched apart from the channel, level and depth settings: fades would dip the
  // seam where the end meets the start, so a loop is written without them.
  async saveLoopWav(): Promise<void> {
    const { app } = this, a = app.audio;
    if (!a) return app.notify.toast('Open an audio file first.');
    const L = app.loopInfo;
    if (!L) return app.notify.toast('Switch the loop on first – drag in the top strip to draw one.');
    const r = renderSlice(a.chans, a.sr, L.a, L.b, { ...this.renderOptions(), fadeIn: 0, fadeOut: 0 });
    await this.save(this.base() + loopTag(L) + '.wav', wavEncode(r.chans, a.sr, app.slicer.bits), 'audio/wav', `Loop saved · ${plural(L.bars, 'bar')} at ${fmtBpm(L.bpm)} BPM`);
  }

  private kept(): SliceView[] | null {
    const { app } = this;
    if (!app.audio) { app.notify.toast('Open an audio file first.'); return null; }
    const list = app.slices.filter((sl) => !sl.off);
    if (!list.length) {
      app.notify.toast(app.slices.length ? 'Every slice is dropped – press “all” to keep them again.' : 'No slices yet – add transients in step 1.');
      return null;
    }
    return list;
  }

  /** Every kept slice as .wav files in a zip, with a .csv and optionally a REAPER project. */
  async exportZip(withRpp: boolean): Promise<void> {
    const { app } = this, list = this.kept(), a = app.audio;
    if (!list || !a) return;
    const base = this.base(), pad = String(list.length).length, o = this.renderOptions(), naming = app.slicer.naming;
    app.notify.busy('Rendering slices', 0.02);
    await tick(20);
    try {
      const files: ZipEntry[] = [];
      for (let i = 0; i < list.length; i++) {
        const r = renderSlice(a.chans, a.sr, list[i].t0, list[i].t1, o);
        files.push({ name: sliceName(base, i, pad, list[i], naming), data: wavEncode(r.chans, a.sr, app.slicer.bits) });
        if ((i & 3) === 0) { app.notify.busy('Rendering slices', 0.02 + (0.86 * (i + 1)) / list.length); await tick(); }
      }
      if (withRpp) {
        const named = list.map((sl, i) => ({ t0: sl.t0, t1: sl.t1, name: files[i].name }));
        const text = buildRppSlices({ ...this.exports.options(), trimmed: false, slices: named, trackName: (a.name || 'Audio') + ' slices' });
        files.push({ name: base + '-slices.rpp', data: new TextEncoder().encode(text) });
      }
      if (app.slicer.csv) files.push({ name: base + '-slices.csv', data: new TextEncoder().encode(slicesCsv(list, base, pad, naming)) });
      app.notify.busy('Packing the zip', 0.94);
      await tick(20);
      const zip = zipFiles(files);
      app.notify.idle();
      const n = plural(list.length, 'slice');
      await this.save(base + loopTag(app.loopInfo) + (withRpp ? '-slices-reaper.zip' : '-slices.zip'), zip, 'application/zip',
        withRpp ? `${n} saved. Unzip, then open the .rpp in REAPER.` : `${n} saved. Unzip to get the .wav files.`);
    } catch (e) {
      console.error(e);
      app.notify.idle();
      app.notify.toast('Too much audio for one zip – loop a shorter part, drop some slices, or use 16-bit mono.');
    }
  }
}
