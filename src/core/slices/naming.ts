import { fmtBpm, fmtTime } from '../format';
import type { LoopInfo, Slice } from './slices';

/** _8bars_96.31bpm: what a loop's files are named with. */
export const loopTag = (L: LoopInfo | null): string => (L ? `_${L.bars}bar${L.bars === 1 ? '' : 's'}_${fmtBpm(L.bpm)}bpm` : '');

/** base_07.wav, or base_07_0-01-234.wav with the start time. */
export function sliceName(base: string, i: number, pad: number, sl: Pick<Slice, 't0'>, naming: 'num' | 'time'): string {
  let n = base + '_' + String(i + 1).padStart(pad, '0');
  if (naming === 'time') n += '_' + fmtTime(sl.t0).replace(/[:.]/g, '-');
  return n + '.wav';
}

/** A list of the slices written, and where each came from. */
export function slicesCsv(list: readonly Slice[], base: string, pad: number, naming: 'num' | 'time'): string {
  const L = ['file,start_seconds,length_seconds,start_time'];
  list.forEach((sl, i) => L.push(`${sliceName(base, i, pad, sl, naming)},${sl.t0.toFixed(6)},${(sl.t1 - sl.t0).toFixed(6)},${fmtTime(sl.t0)}`));
  return L.join('\n') + '\n';
}
