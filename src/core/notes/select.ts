// From the notes found to the notes heard and written: the sensitivity picks among them, the ones
// deleted by hand go, the ones drawn by hand join them, and each gets a velocity and, with Legato on,
// a length up to the next note.
import type { BendPoint, Note } from './types';
import { noteThreshold } from './types';

/** A found note deleted by hand, known by its pitch and start so it stays deleted at any sensitivity. */
export interface RemovedNote {
  readonly pitch: number;
  readonly t: number;
}

/** A note drawn by hand on the piano roll, or a found note moved or resized there. */
export interface ManualNote {
  readonly pitch: number;
  readonly t: number;
  readonly end: number;
  /** How loud it is, on the found notes' scale, so it gets a velocity beside them. */
  readonly a: number;
}

export interface NoteEdits {
  readonly removed: readonly RemovedNote[];
  readonly manual: readonly ManualNote[];
}

export const noNoteEdits = (): NoteEdits => ({ removed: [], manual: [] });

/** A note as it plays and is written: MIDI pitch, start and end in seconds of the audio, velocity. */
export interface HeardNote {
  readonly pitch: number;
  readonly t: number;
  readonly end: number;
  readonly vel: number;
  readonly bend?: readonly BendPoint[];
}

/** A note is known by its pitch and start. */
export const noteKey = (n: { pitch: number; t: number }): string => n.pitch + '@' + n.t;

/** A note shorter than this can't be drawn or resized, seconds. */
export const MIN_NOTE = 0.02;

/**
 * The notes the sensitivity lets through, minus the ones deleted, plus the ones drawn by hand (a drawn
 * note stands in for a found one at the same pitch and start: that is how one is moved or resized),
 * sorted by start.
 */
export function selectNotes(all: readonly Note[], sens: number, e: NoteEdits): Note[] {
  const thr = noteThreshold(sens), rm = new Set(e.removed.map(noteKey)), hand = new Set(e.manual.map(noteKey));
  const out: Note[] = all.filter((n) => n.s >= thr && !rm.has(noteKey(n)) && !hand.has(noteKey(n)));
  for (const m of e.manual) out.push({ pitch: m.pitch, t: m.t, end: m.end, s: 1, a: m.a });
  return out.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
}

/** Adds a drawn note, replacing any drawn before at the same pitch and start. */
export function addManualNote(e: NoteEdits, n: ManualNote): NoteEdits {
  const k = noteKey(n), manual = [...e.manual.filter((m) => noteKey(m) !== k), n].sort((a, b) => a.t - b.t || a.pitch - b.pitch);
  return { ...e, manual };
}

/**
 * Deletes a note, found or drawn: a drawn one is dropped, and a found one at that pitch and start is
 * marked deleted so it stays gone at any sensitivity.
 */
export function removeNote(e: NoteEdits, n: { pitch: number; t: number }, found: boolean): NoteEdits {
  const k = noteKey(n), manual = e.manual.filter((m) => noteKey(m) !== k);
  const removed = found && !e.removed.some((r) => noteKey(r) === k) ? [...e.removed, { pitch: n.pitch, t: n.t }] : e.removed;
  return manual.length === e.manual.length && removed === e.removed ? e : { removed, manual };
}

/**
 * Moves or resizes a note: the note as it was (found or drawn) goes, and a drawn note takes its place
 * where it is put. A found note is marked deleted, so it doesn't come back beside the moved one.
 */
export function moveNote(e: NoteEdits, from: Note, found: boolean, to: { pitch: number; t: number; end: number }): NoteEdits {
  return addManualNote(removeNote(e, from, found), { pitch: to.pitch, t: to.t, end: Math.max(to.t + MIN_NOTE, to.end), a: from.a });
}

/**
 * Velocities as the drums get them: from each note's loudness against the loud notes of the take
 * (its 90th percentile plays at 112), so a note 16 dB down lands in the 50s.
 */
export function noteVelocities(notes: readonly Note[]): number[] {
  const a = notes.map((n) => n.a).sort((x, y) => x - y), ref = a[Math.min(a.length - 1, Math.floor(a.length * 0.9))] || 1;
  return notes.map((n) => Math.max(1, Math.min(127, Math.round(112 + 70 * Math.log10(Math.max(1e-6, n.a) / ref)))));
}

/**
 * The notes to hear and write. With `legato`, each note is held until the next note starts (the next
 * chord, in chords), as a synth bass wants; a note never runs into the next one on its own pitch.
 */
export function heardNotes(notes: readonly Note[], legato: boolean): HeardNote[] {
  const vel = noteVelocities(notes), starts = [...new Set(notes.map((n) => n.t))].sort((a, b) => a - b);
  const out = notes.map((n, i): HeardNote => {
    let end = n.end;
    if (legato) {
      // The next start at least 30 ms on: notes of one chord land a few milliseconds apart.
      const next = starts.find((t) => t > n.t + 0.03);
      if (next !== undefined && next > end) end = next;
    }
    const same = notes.find((m) => m.pitch === n.pitch && m.t > n.t);
    if (same && end > same.t) end = Math.max(n.t + 0.01, same.t);
    return { pitch: n.pitch, t: n.t, end, vel: vel[i], ...(n.bend ? { bend: n.bend } : {}) };
  });
  return out.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
}
