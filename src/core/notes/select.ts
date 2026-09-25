// From the notes found to the notes heard and written: the sensitivity picks among them, the ones
// deleted by hand go, and each gets a velocity and, with Legato on, a length up to the next note.
import type { BendPoint, Note } from './types';
import { noteThreshold } from './types';

/** A found note deleted by hand, known by its pitch and start so it stays deleted at any sensitivity. */
export interface RemovedNote {
  readonly pitch: number;
  readonly t: number;
}

export interface NoteEdits {
  readonly removed: readonly RemovedNote[];
}

export const noNoteEdits = (): NoteEdits => ({ removed: [] });

/** A note as it plays and is written: MIDI pitch, start and end in seconds of the audio, velocity. */
export interface HeardNote {
  readonly pitch: number;
  readonly t: number;
  readonly end: number;
  readonly vel: number;
  readonly bend?: readonly BendPoint[];
}

/** The notes the sensitivity lets through, minus the ones deleted, sorted by start. */
export function selectNotes(all: readonly Note[], sens: number, e: NoteEdits): Note[] {
  const thr = noteThreshold(sens), rm = new Set(e.removed.map((r) => r.pitch + '@' + r.t));
  return all.filter((n) => n.s >= thr && !rm.has(n.pitch + '@' + n.t));
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
