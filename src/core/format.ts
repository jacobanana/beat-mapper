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
