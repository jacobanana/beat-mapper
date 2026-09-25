// Step 6: the notes. A bass line, a lead or chords found in the audio, heard on a synth voice and
// saved as MIDI, as the Groove step does with the drums.
import type { Analyzer } from '../../analysis/analyzer';
import { fmtBpm, safeName } from '../../core/format';
import type { NoteMode } from '../../core/notes/types';
import { noteName } from '../../core/notes/types';
import { hasBridge, saveError, saveFile } from '../../io/download';
import { type PitchedNote, buildMidi } from '../../io/formats/midi';
import { zipFiles } from '../../io/formats/zip';
import { defaultNotes } from '../../state/settings';
import { withNoteEdits } from '../../state/project';
import type { App } from '../app';
import type { Exports } from './exports';
import type { Playback } from './playback';

const FINDING: Record<NoteMode, string> = { line: 'Finding the notes', chords: 'Finding the chords' };

export class Notes {
  private running: Promise<void> | null = null;

  constructor(private readonly app: App, private readonly analyzer: Analyzer, private readonly exports: Exports, private readonly playback: Playback) {}

  /** Finds the notes unless they are already found for this audio as this mode. */
  ensureNotes(): Promise<void> {
    const { app } = this;
    if (!app.audio || (app.transcript && app.transcript.mode === app.notes.mode)) return Promise.resolve();
    return (this.running ??= this.detect().finally(() => { this.running = null; }));
  }

  private async detect(): Promise<void> {
    const { app } = this, audio = app.audio, mode = app.notes.mode;
    app.busy = true;
    app.notify.busy(FINDING[mode], 0.02);
    try {
      const found = await this.analyzer.notes(mode, (f) => app.notify.busy(FINDING[mode], 0.02 + 0.96 * f));
      if (app.audio !== audio) return; // another file was opened meanwhile
      app.transcript = found;
      if (app.sel?.kind === 'note') app.select(null);
      app.bus.emit('transcript');
    } catch (e) {
      console.error(e);
      app.notify.toast("Couldn't find the notes in this audio.");
    } finally {
      app.busy = false;
      app.notify.idle();
    }
    // The mode may have changed while this ran.
    if (app.audio === audio && app.notes.mode !== mode) await this.detect();
  }

  // ---------- settings ----------
  async setMode(mode: NoteMode): Promise<void> {
    if (this.app.notes.mode === mode) return;
    this.app.set('notes', { mode });
    await this.ensureNotes();
  }

  setSensitivity(sens: number): void {
    this.app.set('notes', { sens: Math.max(0, Math.min(100, Math.round(sens))) });
  }

  toggleLegato(): void {
    this.app.set('notes', { legato: !this.app.notes.legato });
    this.app.notify.toast(this.app.notes.legato ? 'Legato: each note held until the next one' : 'Each note as long as it is heard');
  }

  /** The synth voice on or off: the mixer's mute for it, one tap away in the panel. */
  toggleSynth(): void {
    const { app } = this;
    app.set('mute', { notes: !app.mute.notes });
    if (app.transcript) app.notify.toast(app.mute.notes ? 'Synth: muted' : 'Synth: on');
    else if (!app.mute.notes) app.notify.toast('The synth plays the notes once they are found.');
  }

  // ---------- editing ----------
  selectNote(pitch: number, t: number, move = true): void {
    this.app.select({ kind: 'note', pitch, t });
    if (move) { this.playback.seek(t); this.app.reveal(t); }
  }

  /** Deletes a found note; it stays deleted at any sensitivity, and undo brings it back. */
  removeNote(pitch: number, t: number): void {
    this.app.edit((d) => withNoteEdits(d, { removed: [...d.notes.removed, { pitch, t }] }));
    this.app.select(null);
  }

  removeSelected(): void {
    const n = this.app.selectedNote();
    if (n) this.removeNote(n.pitch, n.t);
    else this.app.notify.toast('Select a note first: tap it in the piano roll.');
  }

  /** Something in this step differs from how it starts: a note deleted, or the sensitivity or length changed. */
  get changed(): boolean {
    const { app } = this, n = app.notes, n0 = defaultNotes();
    return !!app.audio && (app.doc.notes.removed.length > 0 || n.sens !== n0.sens || n.legato !== n0.legato);
  }

  /**
   * Starts the step again: every note found, at the starting sensitivity, as long as it is heard. The
   * mode stays, since changing it means finding the notes again. One undo step brings the deletions back.
   */
  reset(): void {
    const { app } = this;
    if (!this.changed) return;
    if (app.doc.notes.removed.length) app.edit((d) => withNoteEdits(d, { removed: [] }));
    const { sens, legato } = defaultNotes();
    app.set('notes', { sens, legato });
    app.select(null);
    app.notify.toast('Notes reset: every note as found. Undo brings your deletions back.');
  }

  /** One line for the panel: how many notes, over what range, and the tuning. */
  summary(): string {
    const { app } = this, a = app.transcript;
    if (!a) return '';
    const ns = app.pickedNotes;
    if (!ns.length) return 'No notes at this sensitivity.';
    let lo = 127, hi = 0;
    for (const n of ns) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
    const tune = Math.round(a.tuning), bent = ns.filter((n) => n.bend).length;
    return `${ns.length} note${ns.length === 1 ? '' : 's'} · ${noteName(lo)}–${noteName(hi)}` + (Math.abs(tune) >= 3 ? ` · tuned ${tune > 0 ? '+' : '−'}${Math.abs(tune)} cents` : '')
      + (bent ? ` · ${bent} bent` : '');
  }

  // ---------- export ----------
  /**
   * The notes as MIDI, as they are heard here. Warped, each note is where the warp puts it (its start,
   * its end and its bends), at the grid's one tempo, lined up with the warped .wav; otherwise where it
   * was played, on the tempo map. Null with nothing to write.
   */
  midi(): { bytes: Uint8Array; notes: readonly PitchedNote[] } | null {
    const { app } = this, out = app.warpOut;
    if (!app.audio || !app.hasMap || !app.heardNotes.length) return null;
    const at = (t: number) => app.placed(t);
    const notes: PitchedNote[] = app.heardNotes.map((n) => ({
      t: at(n.t), end: at(n.end), pitch: n.pitch, vel: n.vel, ...(n.bend ? { bend: n.bend.map((b) => ({ t: at(b.t), cents: b.cents })) } : {}),
    }));
    return { bytes: buildMidi({ ...this.exports.options(out), clicks: false, pitched: notes }).bytes, notes };
  }

  async saveMidi(): Promise<void> {
    const { app } = this, out = app.warpOut;
    if (!app.audio || !app.transcript) return app.notify.toast('Nothing to export yet – open the Notes step to find the notes.');
    let midi: ReturnType<Notes['midi']>;
    try { midi = this.midi(); } catch (e) { console.error(e); midi = null; }
    if (!midi) return app.notify.toast(app.hasMap ? 'No notes at this sensitivity.' : 'Nothing to export yet – map the beats first.');
    const base = safeName(app.audio.name || 'audio') + (out ? '-notes-warped' : '-notes');
    if (await hasBridge()) {
      const r = await saveFile(base + '.zip', zipFiles([{ name: base + '.mid', data: midi.bytes }]) as BlobPart, 'application/zip');
      return app.notify.toast(r.ok ? 'Saved. Unzip it to get the .mid file.' : saveError(r.code, "This viewer couldn't save the file."));
    }
    await saveFile(base + '.mid', midi.bytes as BlobPart, 'audio/midi');
    app.notify.toast(`Notes MIDI saved: ${midi.notes.length} notes${out ? `, warped to ${fmtBpm(out.plan.bpm)} BPM` : ''}.`);
  }
}
