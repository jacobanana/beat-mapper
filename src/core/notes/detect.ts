// The note detector's one entry point: a line or chords, found in mono audio.
import { detectChords } from './chords';
import { detectLine } from './line';
import type { NoteAnalysis, NoteMode } from './types';

export interface NoteOptions {
  mode?: NoteMode;
  onProgress?: (fraction: number) => void;
  yieldToEventLoop?: boolean;
}

export async function detectNotes(x: Float32Array, sr: number, o: NoteOptions = {}): Promise<NoteAnalysis> {
  const { mode = 'line', onProgress, yieldToEventLoop = true } = o;
  const r = mode === 'line' ? await detectLine(x, sr, { onProgress, yieldToEventLoop }) : await detectChords(x, sr, { onProgress, yieldToEventLoop });
  return { mode, notes: [...r.notes].sort((a, b) => a.t - b.t || a.pitch - b.pitch), tuning: r.tuning };
}
