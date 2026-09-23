// The Groove step's chart, in the language of Pocket Science: on the left, where each voice sits
// against the beat (every hit, its middle half and its median); on the right, the typical bar, one
// dot per step with its size for velocity and a tail for its lean.
import type { App } from '../../app/app';
import { VOICES, VOICE_LABEL, type Voice } from '../../core/drums/voices';
import type { Groove } from '../../core/groove/pocket';
import { type Colors, FONT, readColors, rgba } from './theme';

// Hats on top, kick at the bottom: high to low, as a kit is scored.
const ROWS: readonly Voice[] = [...VOICES].reverse();
const LABEL_W = 50, TOP = 22, BOTTOM = 22;
/** The pocket-emphasis stretch, capped so a dot never reaches the next step. */
const EMPH = 3, EMPH_MAX = 0.45;

export class GrooveChart {
  private readonly g: CanvasRenderingContext2D;
  private C: Colors = readColors();
  private queued = false;

  constructor(private readonly cv: HTMLCanvasElement, private readonly app: App) {
    this.g = cv.getContext('2d')!;
    app.bus.on(['drums', 'groove', 'doc', 'transport', 'step', 'audio', 'beats'], () => this.invalidate());
  }

  /** Redraws on the next frame, once however many changes come in before it. */
  invalidate(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.draw(); });
  }

  recolor(): void { this.C = readColors(); this.invalidate(); }

  draw(): void {
    const { cv, g, app } = this;
    if (cv.offsetParent === null) return; // hidden: drawn when the step opens
    const dpr = Math.max(1, window.devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = '12px ' + FONT;
    g.textBaseline = 'middle';
    const p = app.pocket, C = this.C;
    if (!p || !p.hits.length) {
      g.fillStyle = C.dim;
      g.textAlign = 'center';
      g.fillText(app.drums ? 'Map the beats (step 2) to see the pocket' : app.audio ? 'Finding the drums…' : '', w / 2, h / 2);
      g.textAlign = 'left';
      return;
    }
    // Side by side when there is room, else the pocket alone.
    const split = w >= 620 ? Math.round(w * 0.42) : w;
    this.pocket(p, 0, split);
    if (split < w) this.bar(p, split + 8, w - 4);
  }

  private rowY(i: number): number {
    const h = this.cv.clientHeight, rh = (h - TOP - BOTTOM) / ROWS.length;
    return TOP + rh * (i + 0.5);
  }

  private label(v: Voice, y: number, x: number, ref: boolean): void {
    const { g, C } = this;
    g.fillStyle = C[v];
    g.font = '600 12px ' + FONT;
    g.fillText(VOICE_LABEL[v].toUpperCase(), x, y - (ref ? 5 : 0));
    if (ref) { g.font = '11px ' + FONT; g.fillStyle = C.dim; g.fillText('reference', x, y + 8); }
    g.font = '12px ' + FONT;
  }

  /** Ahead / behind in ms, one row per voice. */
  private pocket(p: Groove, x0: number, x1: number): void {
    const { g, C } = this, h = this.cv.clientHeight, L = x0 + LABEL_W, R = x1 - 44;
    let range = 20;
    for (const v of p.voices) range = Math.max(range, Math.abs(v.p25), Math.abs(v.p75));
    range = Math.min(80, Math.ceil((range * 1.15) / 10) * 10);
    const C0 = (L + R) / 2, xOf = (ms: number) => C0 + (Math.max(-range, Math.min(range, ms)) / range) * ((R - L) / 2);
    const axisY = h - BOTTOM + 4;
    g.strokeStyle = C.line; g.lineWidth = 1;
    g.beginPath(); g.moveTo(L, axisY + 0.5); g.lineTo(R, axisY + 0.5); g.stroke();
    const stepMs = range > 40 ? 20 : 10;
    g.fillStyle = C.dim; g.font = '11px ' + FONT; g.textAlign = 'center';
    for (let m = -range; m <= range; m += stepMs) {
      const x = Math.round(xOf(m)) + 0.5;
      g.beginPath(); g.moveTo(x, axisY); g.lineTo(x, axisY + 4); g.stroke();
      g.fillText(m === 0 ? '0' : (m > 0 ? '+' : '−') + Math.abs(m), x, axisY + 12);
    }
    g.textAlign = 'left'; g.fillText('← ahead', L, 9);
    g.textAlign = 'right'; g.fillText('behind →', R, 9);
    g.textAlign = 'center'; g.fillText('ms vs ' + refName(p), C0, 9);
    g.textAlign = 'left';
    g.setLineDash([3, 3]); g.strokeStyle = rgba(C.ink, 0.35);
    g.beginPath(); g.moveTo(Math.round(C0) + 0.5, TOP - 6); g.lineTo(Math.round(C0) + 0.5, axisY); g.stroke(); g.setLineDash([]);
    ROWS.forEach((v, i) => {
      const y = this.rowY(i), st = p.voices.find((s) => s.voice === v), col = C[v];
      this.label(v, y, x0 + 4, p.ref === v);
      if (!st) { g.fillStyle = C.dim; g.fillText('no hits', L + 6, y); return; }
      // every hit, spread up and down a little so they don't all sit on one line
      g.fillStyle = rgba(col, 0.35);
      p.hits.forEach((hh, k) => {
        if (hh.voice !== v) return;
        const jy = (((k * 7919) % 13) / 12 - 0.5) * 10;
        g.beginPath(); g.arc(xOf(hh.ms), y + jy, 1.8, 0, Math.PI * 2); g.fill();
      });
      // the middle half, the lean from the beat, and the median
      g.fillStyle = rgba(col, 0.2);
      const a = xOf(st.p25), b = xOf(st.p75);
      g.beginPath(); if (g.roundRect) g.roundRect(a, y - 6, Math.max(2, b - a), 12, 6); else g.rect(a, y - 6, Math.max(2, b - a), 12); g.fill();
      const cx = xOf(st.median);
      if (Math.abs(cx - C0) > 7) { g.strokeStyle = rgba(col, 0.55); g.lineWidth = 3; g.beginPath(); g.moveTo(C0, y); g.lineTo(cx, y); g.stroke(); g.lineWidth = 1; }
      g.fillStyle = col; g.beginPath(); g.arc(cx, y, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = C.ink; g.font = '500 12px ' + FONT;
      g.fillText(fmtMs(st.median), R + 6, y);
      g.font = '12px ' + FONT;
    });
  }

  /** The typical bar: one dot per step a voice plays, faint when it plays it in only some bars. */
  private bar(p: Groove, x0: number, x1: number): void {
    const { g, C, app } = this, h = this.cv.clientHeight, L = x0 + LABEL_W, R = x1 - 8, n = p.stepsPerBar, cw = (R - L) / n;
    const xOf = (s: number) => L + cw * (s + 0.5), axisY = h - BOTTOM + 4;
    const labels = stepLabels(p);
    g.font = '11px ' + FONT; g.textAlign = 'center';
    for (let s = 0; s < n; s++) {
      const beat = s % p.stepsPerBeat === 0, x = Math.round(xOf(s)) + 0.5;
      g.strokeStyle = beat ? rgba(C.ink, 0.28) : rgba(C.ink, 0.1);
      g.beginPath(); g.moveTo(x, TOP - 6); g.lineTo(x, axisY); g.stroke();
      if (labels[s]) { g.fillStyle = beat ? C.ink : C.dim; g.fillText(labels[s], x, axisY + 12); }
    }
    g.fillStyle = C.dim; g.fillText(`the typical bar of ${p.bars}${app.groove.exaggerate ? ' · offsets ×' + EMPH : ''}`, (L + R) / 2, 9);
    g.textAlign = 'left';
    const emph = app.groove.exaggerate ? EMPH : 1;
    ROWS.forEach((v, i) => {
      const y = this.rowY(i), col = C[v];
      this.label(v, y, x0 + 4, false);
      g.strokeStyle = rgba(C.ink, 0.08); g.setLineDash([2, 4]); g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke(); g.setLineDash([]);
      for (const st of p.steps) {
        if (st.voice !== v) continue;
        const d = Math.sign(st.frac) * Math.min(Math.abs(st.frac) * emph, EMPH_MAX) * cw, gx = xOf(st.step), cx = gx + d;
        const r = st.vel <= 55 ? 3 : st.vel >= 112 ? Math.min(7, cw * 0.4) : Math.min(5.2, cw * 0.34), al = 0.25 + 0.75 * Math.min(1, st.presence);
        if (Math.abs(d) >= r) { g.strokeStyle = rgba(col, 0.8 * al); g.lineWidth = 2; g.beginPath(); g.moveTo(gx, y); g.lineTo(cx - Math.sign(d) * r, y); g.stroke(); g.lineWidth = 1; }
        g.fillStyle = rgba(col, al * (st.vel <= 55 ? 0.7 : 1));
        g.beginPath(); g.arc(cx, y, r, 0, Math.PI * 2); g.fill();
      }
    });
  }
}

const fmtMs = (ms: number) => (Math.abs(ms) < 0.5 ? '0 ms' : (ms > 0 ? '+' : '−') + Math.abs(ms).toFixed(Math.abs(ms) < 10 ? 1 : 0) + ' ms');
const refName = (p: Groove) => (p.ref === 'grid' ? 'grid' : p.ref === 'kit' ? 'kit' : p.ref === 'hat' ? 'hats' : p.ref);

function stepLabels(p: Groove): string[] {
  const out: string[] = [], per = p.stepsPerBeat;
  const sub = per === 4 ? ['', 'e', '&', 'a'] : per === 2 ? ['', '&'] : per === 3 ? ['', 'trip', 'let'] : [];
  for (let s = 0; s < p.stepsPerBar; s++) out.push(s % per === 0 ? String(s / per + 1) : (sub[s % per] ?? ''));
  return out;
}
