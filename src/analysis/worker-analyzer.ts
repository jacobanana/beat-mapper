import type { Algo, Analysis, Band } from '../core/dsp/onset';
import type { DrumAnalysis, DrumSource } from '../core/drums/detect';
import type { NoteAnalysis, NoteInstrument, NoteMode } from '../core/notes/types';
import type { Candidate } from '../core/types';
import type { WarpJob } from '../core/warp/modes';
import { type Analyzer, InlineAnalyzer } from './analyzer';
import type { Request, Response } from './protocol';

type Pending = { resolve: (r: Response) => void; reject: (e: Error) => void; onProgress?: (f: number) => void };
type Payload<T> = T extends unknown ? Omit<T, 'id'> : never;

/**
 * Runs the analysis in a Web Worker, so the page keeps drawing and playing while it works. If the
 * worker can't start (a strict CSP, an old browser), it falls back to analysing on the page.
 */
export class WorkerAnalyzer implements Analyzer {
  private worker: Worker | null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private inline: InlineAnalyzer | null = null;

  constructor() {
    this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<Response>) => {
      const r = e.data, p = this.pending.get(r.id);
      if (!p) return;
      if (r.type === 'progress') { p.onProgress?.(r.fraction); return; }
      this.pending.delete(r.id);
      if (r.type === 'error') p.reject(new Error(r.message));
      else p.resolve(r);
    };
    this.worker.onerror = (e) => {
      console.warn('Analysis worker failed, analysing on the page instead:', e.message);
      this.worker?.terminate();
      this.worker = null;
      for (const p of this.pending.values()) p.reject(new WorkerGone());
      this.pending.clear();
    };
  }

  private request(req: Payload<Request>, transfer: Transferable[] = [], onProgress?: (f: number) => void): Promise<Response> {
    const w = this.worker;
    if (!w) return Promise.reject(new WorkerGone());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      w.postMessage({ ...req, id }, transfer);
    });
  }

  private fallback(): InlineAnalyzer {
    return (this.inline ??= new InlineAnalyzer());
  }

  async analyze(x: Float32Array, sr: number, onProgress?: (f: number) => void): Promise<Analysis> {
    if (this.inline) return this.inline.analyze(x, sr, onProgress);
    // The worker keeps its own copy of the signal; the page's stays for drawing and playback.
    const copy = x.slice();
    try {
      const r = await this.request({ type: 'analyze', x: copy, sr }, [copy.buffer], onProgress);
      if (r.type !== 'analysis') throw new Error('Unexpected reply ' + r.type);
      return r.analysis;
    } catch (e) {
      if (e instanceof WorkerGone) return this.fallback().analyze(x, sr, onProgress);
      throw e;
    }
  }

  async candidates(band: Band, algo: Algo): Promise<Candidate[]> {
    if (this.inline) return this.inline.candidates(band, algo);
    const r = await this.request({ type: 'candidates', band, algo });
    if (r.type !== 'candidates') throw new Error('Unexpected reply ' + r.type);
    return r.candidates;
  }

  async drums(source: DrumSource, onProgress?: (f: number) => void): Promise<DrumAnalysis> {
    if (this.inline) return this.inline.drums(source, onProgress);
    const r = await this.request({ type: 'drums', source }, [], onProgress);
    if (r.type !== 'drums') throw new Error('Unexpected reply ' + r.type);
    return r.drums;
  }

  async notes(mode: NoteMode, instrument: NoteInstrument, onProgress?: (f: number) => void): Promise<NoteAnalysis> {
    if (this.inline) return this.inline.notes(mode, instrument, onProgress);
    const r = await this.request({ type: 'notes', mode, instrument }, [], onProgress);
    if (r.type !== 'notes') throw new Error('Unexpected reply ' + r.type);
    return r.notes;
  }

  async warp(job: WarpJob, onProgress?: (f: number) => void): Promise<Float32Array[]> {
    if (this.inline) return this.inline.warp(job, onProgress);
    // The worker gets its own copies of the channels; the page's stay for drawing and playback.
    const chans = job.chans.map((c) => c.slice());
    try {
      const r = await this.request({ type: 'warp', job: { ...job, chans } }, chans.map((c) => c.buffer), onProgress);
      if (r.type !== 'warp') throw new Error('Unexpected reply ' + r.type);
      return r.chans;
    } catch (e) {
      if (e instanceof WorkerGone) return this.fallback().warp(job, onProgress);
      throw e;
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('Analyzer disposed'));
    this.pending.clear();
    this.inline?.dispose();
  }
}

class WorkerGone extends Error {
  constructor() { super('Analysis worker unavailable'); }
}

export function createAnalyzer(): Analyzer {
  try {
    if (typeof Worker !== 'undefined') return new WorkerAnalyzer();
  } catch {}
  return new InlineAnalyzer();
}
