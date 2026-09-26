// What the note detector finds, and what the rest of the app reads from it.

/** One line at a time (bass, lead, voice), or chords (keys, guitar). */
export const NOTE_MODES = ['line', 'chords'] as const;
export type NoteMode = (typeof NOTE_MODES)[number];

/** What plays the chords: any instrument, or one the chord detector has a profile for. */
export const NOTE_INSTRUMENTS = ['any', 'piano', 'guitar', 'organ', 'mallets'] as const;
export type NoteInstrument = (typeof NOTE_INSTRUMENTS)[number];

/** A point of a note's pitch bend: seconds into the audio, and cents from the note's own pitch. */
export interface BendPoint {
  readonly t: number;
  readonly cents: number;
}

/** One note found in the audio. */
export interface Note {
  /** MIDI note number. */
  readonly pitch: number;
  /** Start and end, seconds in the audio. */
  readonly t: number;
  readonly end: number;
  /** How clearly it stands out, 0..1: what the sensitivity is measured against. */
  readonly s: number;
  /** How loud it is, as a magnitude: velocities are read from it against the loud notes of the take. */
  readonly a: number;
  /** Where the pitch moves off the note and back, in a line; absent when it holds steady. */
  readonly bend?: readonly BendPoint[];
}

export interface NoteAnalysis {
  readonly mode: NoteMode;
  /** The profile the chords were found with; `any` for a line. */
  readonly instrument: NoteInstrument;
  /** Every note found, sorted by start, before the sensitivity picks among them. */
  readonly notes: readonly Note[];
  /** How far the recording is tuned from A440, in cents. */
  readonly tuning: number;
}

/** Sensitivity 0..100 to the strength a note must reach; the same curve as the drums'. */
export const noteThreshold = (sens: number): number => Math.pow(1 - sens / 100, 3);

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
/** A MIDI note number as a name with its octave, middle C being C4. */
export const noteName = (p: number): string => NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
