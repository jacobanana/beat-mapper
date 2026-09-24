// Step 4: cutting the audio into one-shot samples at the transients, and saving them. With the warp
// heard, the samples are cut from the warped audio, so they are what was heard and sit on its grid.
import { fmtBpm, plural, safeName } from '../../core/format';
import { loopTag, sliceName, slicesCsv } from '../../core/slices/naming';
import { type LoopInfo, type RenderOptions, type Slice, renderSlice, sliceKey } from '../../core/slices/slices';
import { bufferFrom } from '../../engine/audio-context';
import { saveError, saveFile } from '../../io/download';
import { buildRppSlices } from '../../io/formats/rpp';
import { wavFile, wavSize } from '../../io/formats/wav';
import { type ZipEntry, zipFiles } from '../../io/formats/zip';
import { type SlicerSettings, defaultSlicer, sliceRenderOptions, wavOptions } from '../../state/settings';
import type { App, SliceView, WarpOut } from '../app';
import type { Exports } from './exports';
import type { Playback } from './playback';
import type { WarpRender } from './warp-render';

const TOO_LARGE = 'Too large for this viewer. Slice a shorter range, or use 16-bit mono.';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** The audio samples are cut from, and where a moment of the original is in it. */
interface Cut {
  chans: readonly Float32Array[];
  sr: number;
  at(t: number): number;
  /** The warp it is, or null for the original. */
  out: WarpOut | null;
}

export class Slicer {
  constructor(private readonly app: App, private readonly playback: Playback, private readonly exports: Exports, private readonly warp: WarpRender) {}

  update(patch: Partial<SlicerSettings>): void { this.app.set('slicer', patch); }

  /** What every rendered slice gets. */
  renderOptions(): RenderOptions { return sliceRenderOptions(this.app.slicer); }

  /** A rendered slice as the .wav it is saved as: at the depth and rate set in Export, dithered or not. */
  private wav(chans: readonly Float32Array[], sr: number): Uint8Array { return wavFile(chans, sr, wavOptions(this.app.slicer)); }

  // What the samples are cut from: the warp when it is heard, rendered first unless it already is,
  // else the audio itself. Null, having said why, if the warp couldn't be rendered.
  private async cut(): Promise<Cut | null> {
    const { app } = this, a = app.audio, out = app.warpOut;
    if (!a) return null;
    if (!out) return { chans: a.chans, sr: a.sr, at: (t) => t, out: null };
    try {
      const r = await this.warp.render();
      // An edit while it rendered makes another warp; the slices are then for that one.
      if (r && app.warpOut?.plan === r.plan) return { chans: r.chans, sr: a.sr, at: app.warpOut.at, out: app.warpOut };
      app.notify.toast('The warp changed while it was rendering – try again.');
    } catch (e) {
      console.error(e);
      app.notify.toast("Couldn't warp the audio – loop a shorter part, or hear the original (W).");
    }
    return null;
  }

  /** A slice as it is in the audio cut from: in the warped file's time when that is the warp. */
  private static placed<T extends Slice>(sl: T, c: Cut): T { return c.out ? { ...sl, t0: c.at(sl.t0), t1: c.at(sl.t1) } : sl; }

  /** The loop as it is named, at the tempo of what is cut. */
  loopHeard(): LoopInfo | null {
    const L = this.app.loopInfo, out = this.app.warpOut;
    return L && out ? { ...L, bpm: out.plan.bpm } : L;
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

  /** Something in this step differs from how it starts: a slice dropped, or where the cuts go. */
  get changed(): boolean {
    const { app } = this, o = app.slicer, o0 = defaultSlicer();
    return !!app.audio && (app.excluded.length > 0 || o.mode !== o0.mode || o.len !== o0.len || o.tail !== o0.tail || o.min !== o0.min);
  }

  /** Starts the step again: every slice kept, cut where it starts. What each .wav gets (set in Export) stays. */
  reset(): void {
    const { app } = this;
    if (!this.changed) return;
    const { mode, len, tail, min } = defaultSlicer();
    this.update({ mode, len, tail, min });
    app.excluded = [];
    app.sliceSel = null;
    app.bus.emit('slices');
    app.notify.toast('Slices reset: every transient starts a slice, and all are kept.');
  }

  /** Plays slice i on its own, rendered exactly as it will be written. */
  preview(i: number): void { void this.previewNow(i); }

  private async previewNow(i: number): Promise<void> {
    const { app, playback } = this, sl = app.slices[i];
    if (!sl || !app.audio) return app.notify.toast('No slice to preview.');
    if (playback.playing) playback.stop(true);
    playback.stopPreview();
    this.select(i);
    app.reveal(sl.t0);
    app.setPlayhead(sl.t0, false);
    const c = await this.cut();
    // Only the slice still selected plays: another may have been picked while the warp rendered.
    if (!c || app.sliceIndex !== i) return;
    const at = Slicer.placed(sl, c), r = renderSlice(c.chans, c.sr, at.t0, at.t1, this.renderOptions());
    playback.oneShot.play(bufferFrom(r.chans, c.sr), sl.t0, sl.t1, () => app.setPlayhead(sl.t0, false), playback.audioLevel);
  }

  previewSelected(): void { this.preview(this.app.sliceIndex ?? 0); }

  /** Rough size of the zip of every kept slice. */
  zipEstimate(): number {
    const { app } = this, o = app.slicer, ch = o.mono ? 1 : (app.audio?.chans.length ?? 1), sr = o.rate ?? app.audio?.sr ?? 44100;
    const len = (sl: Slice) => app.placed(sl.t1) - app.placed(sl.t0);
    let n = 0;
    for (const sl of this.app.slices) if (!sl.off) n += wavSize(Math.round(len(sl) * sr), ch, o.bits) + 180;
    return n;
  }

  private base(): string { return safeName(this.app.audio?.name || 'audio') || 'audio'; }

  // ---------- saving ----------
  private async save(filename: string, data: Uint8Array, mime: string, ok: string): Promise<void> {
    const r = await saveFile(filename, data as BlobPart, mime);
    this.app.notify.toast(r.ok ? ok : saveError(r.code, TOO_LARGE));
  }

  async saveSelectedWav(): Promise<void> {
    const { app } = this, S = app.slices;
    if (!S.length || !app.audio) return app.notify.toast('No slices yet.');
    const i = app.sliceIndex ?? 0;
    this.select(i);
    const c = await this.cut(), sl = app.slices[i];
    if (!c || !sl) return;
    const at = Slicer.placed(sl, c), r = renderSlice(c.chans, c.sr, at.t0, at.t1, this.renderOptions());
    await this.save(sliceName(this.base(), i, String(app.slices.length).length, at, app.slicer.naming), this.wav(r.chans, c.sr), 'audio/wav', 'Slice ' + (i + 1) + ' saved');
  }

  // The loop itself, untouched apart from the channel, level and depth settings: fades would dip the
  // seam where the end meets the start, so a loop is written without them. Warped, it is the loop as
  // the warp makes it, at the grid's tempo, named as the Warp step names a warped loop.
  async saveLoopWav(): Promise<void> {
    const { app } = this;
    if (!app.audio) return app.notify.toast('Open an audio file first.');
    if (!app.loopInfo) return app.notify.toast('Switch the loop on first – drag in the top strip to draw one.');
    const c = await this.cut(), L = this.loopHeard();
    if (!c || !L) return;
    const r = renderSlice(c.chans, c.sr, c.at(Math.max(L.a, c.out?.range.a ?? 0)), c.at(Math.min(L.b, c.out?.range.b ?? app.dur)), { ...this.renderOptions(), fadeIn: 0, fadeOut: 0 });
    const name = this.base() + loopTag(L) + (c.out ? '_warped' : '') + '.wav';
    await this.save(name, this.wav(r.chans, c.sr), 'audio/wav', `Loop saved · ${plural(L.bars, 'bar')} at ${fmtBpm(L.bpm)} BPM${c.out ? ', warped' : ''}`);
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

  /**
   * Every kept slice as .wav files in a zip, with a .csv and optionally a REAPER project. Warped, the
   * times in both are the warped file's, and the project is at the grid's one tempo.
   */
  async exportZip(withRpp: boolean): Promise<void> {
    const { app } = this, a = app.audio;
    if (!this.kept() || !a) return;
    const c = await this.cut(), kept = this.kept();
    if (!c || !kept) return;
    const list = kept.map((sl) => Slicer.placed(sl, c));
    const base = this.base(), pad = String(list.length).length, o = this.renderOptions(), naming = app.slicer.naming;
    app.notify.busy('Rendering slices', 0.02);
    await tick(20);
    try {
      const files: ZipEntry[] = [];
      for (let i = 0; i < list.length; i++) {
        const r = renderSlice(c.chans, c.sr, list[i].t0, list[i].t1, o);
        files.push({ name: sliceName(base, i, pad, list[i], naming), data: this.wav(r.chans, c.sr) });
        if ((i & 3) === 0) { app.notify.busy('Rendering slices', 0.02 + (0.86 * (i + 1)) / list.length); await tick(); }
      }
      if (withRpp) {
        const named = list.map((sl, i) => ({ t0: sl.t0, t1: sl.t1, name: files[i].name }));
        const text = buildRppSlices({ ...this.exports.options(c.out), trimmed: false, slices: named, trackName: (a.name || 'Audio') + ' slices' });
        files.push({ name: base + '-slices.rpp', data: new TextEncoder().encode(text) });
      }
      if (app.slicer.csv) files.push({ name: base + '-slices.csv', data: new TextEncoder().encode(slicesCsv(list, base, pad, naming)) });
      app.notify.busy('Packing the zip', 0.94);
      await tick(20);
      const zip = zipFiles(files);
      app.notify.idle();
      const n = plural(list.length, 'slice');
      await this.save(base + loopTag(this.loopHeard()) + (c.out ? '_warped' : '') + (withRpp ? '-slices-reaper.zip' : '-slices.zip'), zip, 'application/zip',
        withRpp ? `${n} saved. Unzip, then open the .rpp in REAPER.` : `${n} saved. Unzip to get the .wav files.`);
    } catch (e) {
      console.error(e);
      app.notify.idle();
      app.notify.toast('Too much audio for one zip – loop a shorter part, drop some slices, or use 16-bit mono.');
    }
  }
}
