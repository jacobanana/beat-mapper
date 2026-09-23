import type { Algo, Analysis, Band } from '../core/dsp/onset';
import type { DrumAnalysis, DrumSource } from '../core/drums/detect';
import type { Candidate } from '../core/types';

export type Request =
  | { id: number; type: 'analyze'; x: Float32Array; sr: number }
  | { id: number; type: 'candidates'; band: Band; algo: Algo }
  | { id: number; type: 'drums'; source: DrumSource };

export type Response =
  | { id: number; type: 'progress'; fraction: number }
  | { id: number; type: 'analysis'; analysis: Analysis }
  | { id: number; type: 'candidates'; candidates: Candidate[] }
  | { id: number; type: 'drums'; drums: DrumAnalysis }
  | { id: number; type: 'error'; message: string };
