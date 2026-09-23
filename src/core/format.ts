// Display formatting shared by the UI and the file names it writes.

/** m:ss.mmm */
export function fmtTime(t: number): string {
  if (!isFinite(t)) return '–';
  const s = Math.max(0, t), m = Math.floor(s / 60);
  return m + ':' + (s - m * 60).toFixed(3).padStart(6, '0');
}

/** A tempo with at most two decimals and no trailing zeros. */
export const fmtBpm = (b: number): string => String(+b.toFixed(2));

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A name safe to use in a file name. */
export const safeName = (name: string): string => name.replace(/[^\w-]+/g, '-').slice(0, 60);

/**
 * A tempo written in a file name, as sample packs and bounces do: "loop_92.9bpm", "Groove 120 BPM",
 * "beat-85bpm". Null when there is none or it is outside 40..300.
 */
export function bpmFromName(name: string): number | null {
  const m = /(?:^|[^\d.])(\d{2,3}(?:\.\d{1,2})?)\s*[-_ ]?bpm/i.exec(name);
  const b = m ? +m[1] : NaN;
  return b >= 40 && b <= 300 ? b : null;
}
