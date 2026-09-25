import { type Algo, type Analysis, type Band, analyze } from '../core/dsp/onset';
import { type DrumAnalysis, type DrumSource, detectDrums } from '../core/drums/detect';
import { pickCandidates } from '../core/markers/detect';
import { detectNotes } from '../core/notes/detect';
import type { NoteAnalysis, NoteMode } from '../core/notes/types';
import type { Candidate } from '../core/types';
import { type WarpJob, renderWarp } from '../core/warp/modes';

/**
 * Finds the transients in a signal, and renders warped audio. Both are heavy (an FFT per 6 ms of
 * audio, and a sample-level look at every candidate; an FFT or a waveform search per few ms of every
 * channel), so the app runs them in a worker; this interface lets the rest of the app not care where
 * they run.
 */
export interface Analyzer {
  /** Analyses a new signal. Later `candidates` calls read from it. */
  analyze(x: Float32Array, sr: number, onProgress?: (f: number) => void): Promise<Analysis>;
  /** The candidate transients for one detection function and band of the last analysis. */
  candidates(band: Band, algo: Algo): Promise<Candidate[]>;
  /** Kick, snare and hat hits in the last analysed signal. */
  drums(source: DrumSource, onProgress?: (f: number) => void): Promise<DrumAnalysis>;
  /** The notes in the last analysed signal, as one line or as chords. */
  notes(mode: NoteMode, onProgress?: (f: number) => void): Promise<NoteAnalysis>;
  /** The audio re-timed onto a straight grid. */
  warp(job: WarpJob, onProgress?: (f: number) => void): Promise<Float32Array[]>;
  dispose(): void;
}

/** Runs on the calling thread. Used inside the worker, in tests, and where workers are missing. */
export class InlineAnalyzer implements Analyzer {
  private x: Float32Array | null = null;
  private sr = 44100;
  private an: Analysis | null = null;

  constructor(private readonly yieldToEventLoop = true) {}

  async analyze(x: Float32Array, sr: number, onProgress?: (f: number) => void): Promise<Analysis> {
    this.x = x;
    this.sr = sr;
    this.an = await analyze(x, sr, { onProgress, yieldToEventLoop: this.yieldToEventLoop });
    return this.an;
  }

  async candidates(band: Band, algo: Algo): Promise<Candidate[]> {
    if (!this.an || !this.x) throw new Error('Nothing analysed yet');
    return pickCandidates(this.an, band, this.x, this.sr, algo);
  }

  async drums(source: DrumSource, onProgress?: (f: number) => void): Promise<DrumAnalysis> {
    if (!this.x) throw new Error('Nothing analysed yet');
    return detectDrums(this.x, this.sr, { source, onProgress, yieldToEventLoop: this.yieldToEventLoop });
  }

  async notes(mode: NoteMode, onProgress?: (f: number) => void): Promise<NoteAnalysis> {
    if (!this.x) throw new Error('Nothing analysed yet');
    return detectNotes(this.x, this.sr, { mode, onProgress, yieldToEventLoop: this.yieldToEventLoop });
  }

  async warp(job: WarpJob, onProgress?: (f: number) => void): Promise<Float32Array[]> {
    return renderWarp(job, onProgress);
  }

  dispose(): void {
    this.x = null;
    this.an = null;
  }
}
