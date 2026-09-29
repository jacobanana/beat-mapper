// Step 6: the notes. A bass line, a lead or chords found in the audio, or drawn by hand on its
// spectrogram, heard on a synth voice and saved as MIDI, as the Groove step does with the drums.
import type { Analyzer } from '../../analysis/analyzer';
import { fmtBpm, safeName } from '../../core/format';
import { drawnByHand } from '../../core/notes/detect';
import { MIN_NOTE, addManualNote, moveNote, noteKey, removeNote } from '../../core/notes/select';
import { SPEC_FILTER_LIMITS, type SpecFilter, defaultSpecFilter } from '../../core/notes/spec-filter';
import { HARMONICS_RANGE, type SpecView, levelAt } from '../../core/notes/spectrogram';
import type { Note, NoteInstrument, NoteMode } from '../../core/notes/types';
import { noteName } from '../../core/notes/types';
import { hasBridge, saveError, saveFile } from '../../io/download';
import { type PitchedNote, buildMidi } from '../../io/formats/midi';
import { zipFiles } from '../../io/formats/zip';
import { NOTE_SNAPS, type NoteMainView, type NoteSnap, SPEC_RANGE, defaultNotes } from '../../state/settings';
import { type ProjectDoc, withNoteEdits } from '../../state/project';
import type { App } from '../app';
import type { Exports } from './exports';
import type { Playback } from './playback';

const NOTE_SNAP: Record<NoteSnap, string> = {
  both: 'Notes snap to a transient near, else to the grid (hold Alt to bypass)',
  grid: 'Notes snap to the grid (hold Alt to bypass)',
  markers: 'Notes snap to transients (hold Alt to bypass)',
  off: 'Notes snap to nothing',
};

const FINDING: Record<NoteMode, string> = { line: 'Finding the notes', chords: 'Finding the chords', draw: '' };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

export class Notes {
  private running: Promise<void> | null = null;
  private drawing: Promise<void> | null = null;
  /** The document a drag started from: each move is applied to it afresh, so the drag is one undo step. */
  private dragBase: ProjectDoc | null = null;

  constructor(private readonly app: App, private readonly analyzer: Analyzer, private readonly exports: Exports, private readonly playback: Playback) {}

  /**
   * Finds the notes unless they are already found for this audio as this mode and instrument, and
   * makes the spectrogram if it is shown and not made yet.
   */
  ensureNotes(): Promise<void> {
    const { app } = this;
    if (!app.audio) return Promise.resolve();
    const notes = this.current() ? Promise.resolve() : (this.running ??= this.detect().finally(() => { this.running = null; }));
    return notes.then(() => this.ensureSpectrogram());
  }

  /** Makes the spectrogram under the piano roll, once per file, when the step shows it. */
  ensureSpectrogram(): Promise<void> {
    const { app } = this;
    if (!app.audio || app.spectrum || !app.notes.spec) return Promise.resolve();
    return (this.drawing ??= this.makeSpectrogram().finally(() => { this.drawing = null; }));
  }

  /** Whether the notes found are the ones these settings ask for; a line is the same on any instrument. */
  private current(): boolean {
    const { transcript: t, notes: s } = this.app;
    return !!t && t.mode === s.mode && (s.mode !== 'chords' || t.instrument === s.instrument);
  }

  private async detect(): Promise<void> {
    const { app } = this, audio = app.audio, { mode, instrument } = app.notes;
    if (mode === 'draw') {
      // Nothing to find: the roll starts empty, with the spectrogram to draw on.
      app.transcript = drawnByHand();
      if (app.sel?.kind === 'note') app.select(null);
      app.bus.emit('transcript');
      return;
    }
    app.busy = true;
    app.notify.busy(FINDING[mode], 0.02);
    try {
      const found = await this.analyzer.notes(mode, instrument, (f) => app.notify.busy(FINDING[mode], 0.02 + 0.96 * f));
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
    // The mode or the instrument may have changed while this ran.
    if (app.audio === audio && !this.current()) await this.detect();
  }

  private async makeSpectrogram(): Promise<void> {
    const { app } = this, audio = app.audio;
    app.busy = true;
    app.notify.busy('Drawing the spectrogram', 0.02);
    try {
      const s = await this.analyzer.spectrogram((f) => app.notify.busy('Drawing the spectrogram', 0.02 + 0.96 * f));
      if (app.audio !== audio) return;
      app.spectrum = s;
      app.bus.emit('spectrum');
    } catch (e) {
      console.error(e);
      app.notify.toast("Couldn't draw the spectrogram of this audio.");
    } finally {
      app.busy = false;
      app.notify.idle();
    }
  }

  // ---------- settings ----------
  async setMode(mode: NoteMode): Promise<void> {
    if (this.app.notes.mode === mode) return;
    this.app.set('notes', { mode });
    if (mode === 'draw' && !this.app.notes.spec) this.setSpectrogram(true);
    await this.ensureNotes();
  }

  async setInstrument(instrument: NoteInstrument): Promise<void> {
    if (this.app.notes.instrument === instrument) return;
    this.app.set('notes', { instrument });
    await this.ensureNotes();
  }

  setSensitivity(sens: number): void {
    this.app.set('notes', { sens: clamp(Math.round(sens), 0, 100) });
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

  /** The spectrogram under the piano roll on or off; on, it is made if it isn't yet. */
  setSpectrogram(on: boolean): void {
    if (this.app.notes.spec === on) return;
    this.app.set('notes', { spec: on });
    if (on) void this.ensureSpectrogram();
  }

  toggleSpectrogram(): void { this.setSpectrogram(!this.app.notes.spec); }

  setView(view: SpecView): void { this.app.set('notes', { view }); }

  setHarmonics(n: number): void {
    this.app.set('notes', { harmonics: clamp(Math.round(n), HARMONICS_RANGE.min, HARMONICS_RANGE.max) });
  }

  /** One or more of the spectrogram's filters, each kept in its range. */
  setFilter(patch: Partial<SpecFilter>): void {
    const f = { ...this.app.notes.filter, ...patch }, L = SPEC_FILTER_LIMITS;
    for (const k of ['steady', 'floor', 'minLen', 'voices'] as const) f[k] = clamp(Math.round(f[k]), L[k].min, L[k].max);
    this.app.set('notes', { filter: f });
  }

  /** The spectrogram's filters as they start. */
  resetFilter(): void { this.app.set('notes', { filter: defaultSpecFilter() }); }

  /** The notes over the spectrogram shown or hidden, to see the spectrogram alone. */
  toggleNotes(): void {
    const { app } = this, showNotes = !app.notes.showNotes;
    app.set('notes', { showNotes });
    app.notify.toast(showNotes ? 'Notes: shown' : 'Notes: hidden, the spectrogram alone');
  }

  /** The transients drawn on the roll or not: the lines a note's start can be put on. */
  toggleTransients(): void {
    const { app } = this, transients = !app.notes.transients;
    app.set('notes', { transients });
    app.notify.toast(transients ? 'Transients: shown on the roll' : 'Transients: hidden');
  }

  /** What a note drawn, moved or lengthened on the roll lands on. */
  setSnap(snap: NoteSnap, quiet = false): void {
    this.app.set('notes', { snap });
    if (!quiet) this.app.notify.toast(NOTE_SNAP[snap]);
  }

  cycleSnap(dir: 1 | -1): void {
    const i = NOTE_SNAPS.indexOf(this.app.notes.snap);
    this.setSnap(NOTE_SNAPS[(i + dir + NOTE_SNAPS.length) % NOTE_SNAPS.length]);
  }

  setRange(db: number): void {
    this.app.set('notes', { range: clamp(Math.round(db), SPEC_RANGE.min, SPEC_RANGE.max) });
  }

  /** The waveform or the piano roll in the main view: the same roll, moved up there and made bigger. */
  setMain(main: NoteMainView): void { this.app.set('notes', { main }); }

  toggleMain(): void { this.setMain(this.app.notes.main === 'wave' ? 'roll' : 'wave'); }

  /** The pencil: drags on the roll draw notes, move them and resize them, rather than scrolling the page. */
  toggleDraw(): void {
    const { app } = this, draw = !app.notes.draw;
    // Drawing on notes that can't be seen would move and delete them blind.
    app.set('notes', draw ? { draw, showNotes: true } : { draw });
    app.notify.toast(draw ? 'Draw: drag on the roll to draw a note, drag a note to move it, its end to lengthen it' : 'Draw: off');
  }

  // ---------- editing ----------
  selectNote(pitch: number, t: number, move = true): void {
    this.app.select({ kind: 'note', pitch, t });
    if (move) { this.playback.seek(t); this.app.reveal(t); }
  }

  /** Whether a note at this pitch and start is one the detector found (rather than one drawn). */
  private isFound(n: { pitch: number; t: number }): boolean {
    const k = noteKey(n);
    return !!this.app.transcript?.notes.some((f) => noteKey(f) === k);
  }

  /**
   * How loud a drawn note is, on the found notes' scale: read from the spectrogram at its pitch over
   * its length, scaled by how the found notes' loudness compares to theirs there; with nothing to
   * compare against, as loud as the spectrogram says, so drawn notes sit against each other.
   */
  private loudness(pitch: number, t: number, end: number): number {
    const { app } = this, s = app.spectrum;
    const found = app.pickedNotes.filter((n) => this.isFound(n));
    if (!s) return found.length ? median(found.map((n) => n.a)) : 1;
    const level = levelAt(s, pitch, t, end);
    const ratios = found.map((n) => n.a / (levelAt(s, n.pitch, n.t, n.end) || 1e-6)).filter((r) => Number.isFinite(r) && r > 0);
    return Math.max(1e-6, level * (ratios.length ? median(ratios) : 1));
  }

  /** Draws a note at `pitch` from t to end (at least 20 ms), and selects it. Undo takes it away. */
  addNote(pitch: number, t: number, end: number): void {
    const { app } = this;
    pitch = clamp(Math.round(pitch), 0, 127);
    t = clamp(t, 0, app.dur);
    end = Math.max(t + MIN_NOTE, Math.min(end, app.dur + 10));
    app.edit((d) => withNoteEdits(d, addManualNote(d.notes, { pitch, t, end, a: this.loudness(pitch, t, end) })));
    this.selectNote(pitch, t, false);
  }

  /**
   * Starts moving or resizing a note by hand: one undo step for the whole drag, however many times
   * `dragTo` is called before `endDrag`.
   */
  beginDrag(): void {
    this.app.checkpoint();
    this.dragBase = this.app.doc;
  }

  /** The note `from` (as it was when the drag began) put at `to`, applied to the document the drag started from. */
  dragTo(from: Note, to: { pitch: number; t: number; end: number }): void {
    const { app } = this, base = this.dragBase ?? app.doc;
    const pitch = clamp(Math.round(to.pitch), 0, 127), t = clamp(to.t, 0, app.dur), end = Math.max(t + MIN_NOTE, Math.min(to.end, app.dur + 10));
    const edits = moveNote(base.notes, from, this.isFound(from), { pitch, t, end });
    app.edit(() => withNoteEdits(base, edits), false);
    app.select({ kind: 'note', pitch, t });
  }

  endDrag(): void { this.dragBase = null; }

  /** Deletes a note, found or drawn; a found one stays deleted at any sensitivity, and undo brings it back. */
  removeNote(pitch: number, t: number): void {
    this.app.edit((d) => withNoteEdits(d, removeNote(d.notes, { pitch, t }, this.isFound({ pitch, t }))));
    this.app.select(null);
  }

  removeSelected(): void {
    const n = this.app.selectedNote();
    if (n) this.removeNote(n.pitch, n.t);
    else this.app.notify.toast('Select a note first: tap it in the piano roll.');
  }

  /** Something in this step differs from how it starts: a note deleted or drawn, or the sensitivity or length changed. */
  get changed(): boolean {
    const { app } = this, n = app.notes, n0 = defaultNotes(), e = app.doc.notes;
    return !!app.audio && (e.removed.length > 0 || e.manual.length > 0 || n.sens !== n0.sens || n.legato !== n0.legato);
  }

  /**
   * Starts the step again: every note as found, none drawn, at the starting sensitivity, as long as it
   * is heard. The mode and the spectrogram's view stay, since changing the mode means finding the notes
   * again and the view is how the user likes to look. One undo step brings the note edits back.
   */
  reset(): void {
    const { app } = this;
    if (!this.changed) return;
    const e = app.doc.notes;
    if (e.removed.length || e.manual.length) app.edit((d) => withNoteEdits(d, { removed: [], manual: [] }));
    const { sens, legato } = defaultNotes();
    app.set('notes', { sens, legato });
    app.select(null);
    app.notify.toast('Notes reset: every note as found. Undo brings your note edits back.');
  }

  /** One line for the panel: how many notes, over what range, the tuning, and how many were drawn. */
  summary(): string {
    const { app } = this, a = app.transcript;
    if (!a) return '';
    const ns = app.pickedNotes, drawn = app.doc.notes.manual.length;
    if (!ns.length) return a.mode === 'draw' ? 'No notes yet: switch on Draw and drag on the roll.' : 'No notes at this sensitivity.';
    let lo = 127, hi = 0;
    for (const n of ns) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
    const tune = Math.round(a.tuning), bent = ns.filter((n) => n.bend).length;
    return `${ns.length} note${ns.length === 1 ? '' : 's'} · ${noteName(lo)}–${noteName(hi)}` + (Math.abs(tune) >= 3 ? ` · tuned ${tune > 0 ? '+' : '−'}${Math.abs(tune)} cents` : '')
      + (bent ? ` · ${bent} bent` : '') + (drawn && a.mode !== 'draw' ? ` · ${drawn} drawn` : '');
  }

  // ---------- export ----------
  /**
   * The notes as MIDI, as they are heard here. Warped, each note is where the warp puts it (its start,
   * its end and its bends), at the grid's one tempo, lined up with the warped .wav; otherwise where it
   * was played, on the tempo map. Null with nothing to write.
   */
  midi(): { bytes: Uint8Array; notes: readonly PitchedNote[] } | null {
    const { app } = this, out = app.warpOut, notes = this.pitchedNotes();
    if (!notes) return null;
    return { bytes: buildMidi({ ...this.exports.options(out), clicks: false, pitched: notes }).bytes, notes };
  }

  /** The notes heard, each where what is heard has it (its start, end and bends). Null with none to write. */
  pitchedNotes(): PitchedNote[] | null {
    const { app } = this;
    if (!app.audio || !app.hasMap || !app.heardNotes.length) return null;
    const at = (t: number) => app.placed(t);
    return app.heardNotes.map((n) => ({
      t: at(n.t), end: at(n.end), pitch: n.pitch, vel: n.vel, ...(n.bend ? { bend: n.bend.map((b) => ({ t: at(b.t), cents: b.cents })) } : {}),
    }));
  }

  async saveMidi(): Promise<void> {
    const { app } = this, out = app.warpOut;
    if (!app.audio || !app.transcript) return app.notify.toast('Nothing to export yet – open the Notes step to find the notes.');
    let midi: ReturnType<Notes['midi']>;
    try { midi = this.midi(); } catch (e) { console.error(e); midi = null; }
    if (!midi) return app.notify.toast(app.hasMap ? (app.notes.mode === 'draw' ? 'No notes drawn yet.' : 'No notes at this sensitivity.') : 'Nothing to export yet – map the beats first.');
    const base = safeName(app.audio.name || 'audio') + (out ? '-notes-warped' : '-notes');
    if (await hasBridge()) {
      const r = await saveFile(base + '.zip', zipFiles([{ name: base + '.mid', data: midi.bytes }]) as BlobPart, 'application/zip');
      return app.notify.toast(r.ok ? 'Saved. Unzip it to get the .mid file.' : saveError(r.code, "This viewer couldn't save the file."));
    }
    await saveFile(base + '.mid', midi.bytes as BlobPart, 'audio/midi');
    app.notify.toast(`Notes MIDI saved: ${midi.notes.length} notes${out ? `, warped to ${fmtBpm(out.plan.bpm)} BPM` : ''}.`);
  }
}
