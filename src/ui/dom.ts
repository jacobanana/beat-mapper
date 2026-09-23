// Small DOM helpers shared by the panels.

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing #' + id);
  return el;
}
export const $in = (id: string) => $(id) as HTMLInputElement;
export const $sel = (id: string) => $(id) as HTMLSelectElement;
export const $btn = (id: string) => $(id) as HTMLButtonElement;

export const icon = (n: string): string => '<svg class="ic"><use href="#i-' + n + '"/></svg>';

/** Sets a toggle button's look and its aria-pressed. */
export function setPressed(el: HTMLElement, on: boolean): void {
  el.classList.toggle('on', on);
  el.setAttribute('aria-pressed', String(on));
}

/** Sets text only when it differs, so rows under the pointer aren't disturbed. */
export function setText(el: Element, t: string): void {
  if (el.textContent !== t) el.textContent = t;
}

/** Sets an input's value unless the user is typing in it. */
export function setValue(el: HTMLInputElement | HTMLSelectElement, v: string | number): void {
  if (document.activeElement === el && el instanceof HTMLInputElement && el.type === 'number') return;
  const s = String(v);
  if (el.value !== s) el.value = s;
}

export function clampNum(v: string, dflt: number, lo: number, hi: number): number {
  const n = +v;
  return Math.max(lo, Math.min(hi, n || dflt));
}
