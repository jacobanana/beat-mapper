import type { TimeRange } from '../core/types';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** The visible stretch of the audio, and the mapping between time and x in CSS pixels. */
export class Viewport {
  t0 = 0;
  t1 = 1;
  /** Length of the audio, seconds. */
  dur = 1;
  /** Width of the waveform, CSS pixels. */
  width = 1;

  get span(): number { return this.t1 - this.t0; }
  get minSpan(): number { return Math.min(0.004, this.dur); }

  xOf(t: number): number { return ((t - this.t0) / (this.t1 - this.t0)) * this.width; }
  tOf(x: number): number { return this.t0 + (x / this.width) * (this.t1 - this.t0); }

  reset(dur: number): void {
    this.dur = dur;
    this.t0 = 0;
    this.t1 = dur;
  }

  /** Shows t0..t1, kept inside the audio and no narrower than 4 ms. */
  set(t0: number, t1: number): void {
    const span = clamp(t1 - t0, this.minSpan, this.dur);
    if (t0 < 0) t0 = 0;
    if (t0 + span > this.dur) t0 = this.dur - span;
    this.t0 = t0;
    this.t1 = t0 + span;
  }

  /** Zooms by factor f keeping time tc where it is on screen. */
  zoomAt(f: number, tc: number): void {
    const span = clamp(this.span * f, this.minSpan, this.dur), r = (tc - this.t0) / this.span;
    this.set(tc - r * span, tc - r * span + span);
  }

  /** Scrolls so t is on screen, if it isn't comfortably already. */
  reveal(t: number): void {
    const span = this.span;
    if (t < this.t0 + span * 0.05 || t > this.t1 - span * 0.05) this.set(t - span * 0.35, t + span * 0.65);
  }

  contains(t: number): boolean { return t >= this.t0 && t <= this.t1; }

  get range(): TimeRange { return { a: this.t0, b: this.t1 }; }
}
