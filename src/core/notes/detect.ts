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

/** By hand: nothing is found; every note is one the user draws. */
export const drawnByHand = (): NoteAnalysis => ({ mode: 'draw', instrument: 'any', notes: [], tuning: 0 });

export async function detectNotes(x: Float32Array, sr: number, o: NoteOptions = {}): Promise<NoteAnalysis> {
  const { mode = 'line', onProgress, yieldToEventLoop = true } = o, instrument = mode === 'chords' ? (o.instrument ?? 'any') : 'any';
  if (mode === 'draw') return drawnByHand();
  const r = mode === 'line' ? await detectLine(x, sr, { onProgress, yieldToEventLoop }) : await detectChords(x, sr, { params: CHORD_PROFILES[instrument], onProgress, yieldToEventLoop });
  return { mode, instrument, notes: [...r.notes].sort((a, b) => a.t - b.t || a.pitch - b.pitch), tuning: r.tuning };
}
