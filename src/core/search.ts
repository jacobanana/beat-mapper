import type { Timed } from './types';

/** Index of the first item with t >= the given time, in an array sorted by t. */
export function lowerBound(arr: readonly Timed[], t: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].t < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** The item closest to t, or undefined for an empty array. */
export function nearest<T extends Timed>(arr: readonly T[], t: number): T | undefined {
  const i = lowerBound(arr, t);
  return !arr[i] || (arr[i - 1] && t - arr[i - 1].t < arr[i].t - t) ? arr[i - 1] : arr[i];
}
