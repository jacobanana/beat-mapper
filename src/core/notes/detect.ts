// The note detector's one entry point: a line or chords, found in mono audio.
import { CHORD_PROFILES, detectChords } from './chords';
import { detectLine } from './line';
import type { NoteAnalysis, NoteInstrument, NoteMode } from './types';

export interface NoteOptions {
  mode?: NoteMode;
  /** The chord detector's profile; a line has none. */
  instrument?: NoteInstrument;
  onProgress?: (fraction: number) => void;
  yieldToEventLoop?: boolean;
}

export async function detectNotes(x: Float32Array, sr: number, o: NoteOptions = {}): Promise<NoteAnalysis> {
  const { mode = 'line', onProgress, yieldToEventLoop = true } = o, instrument = mode === 'line' ? 'any' : (o.instrument ?? 'any');
  const r = mode === 'line' ? await detectLine(x, sr, { onProgress, yieldToEventLoop }) : await detectChords(x, sr, { params: CHORD_PROFILES[instrument], onProgress, yieldToEventLoop });
  return { mode, instrument, notes: [...r.notes].sort((a, b) => a.t - b.t || a.pitch - b.pitch), tuning: r.tuning };
}
