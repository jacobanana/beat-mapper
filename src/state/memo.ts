/**
 * Caches the last result of `fn` for as long as every dependency is identical (===). Derived data
 * such as the visible markers or the bar list is recomputed only when something it reads changed.
 */
export function memo<D extends readonly unknown[], R>(fn: (...deps: D) => R): (...deps: D) => R {
  let last: D | null = null, value: R;
  return (...deps: D) => {
    if (last && last.length === deps.length && deps.every((d, i) => d === last![i])) return value;
    value = fn(...deps);
    last = deps;
    return value;
  };
}
