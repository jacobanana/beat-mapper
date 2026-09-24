// The Groove step's chart, in the language of Pocket Science: on the left, where each voice sits
// against the beat (every hit, its middle half and its median); on the right, the typical bar, one
// dot per step with its size for velocity and a tail for its lean. Or, switched over, the hits as a
// MIDI transcript: one lane per voice, every note where it was played, under a moving playhead.
import type { App } from '../../app/app';
import { GM_NOTE, VOICES, VOICE_LABEL, type Voice } from '../../core/drums/voices';
import { GROOVE_GRID_Q, type Groove } from '../../core/groove/pocket';
import { lowerBound } from '../../core/search';
import { barQ, beatQ } from '../../core/tempo/meter';
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
    // The transcript follows the playhead and the editor's view; the pocket doesn't move with them.
    app.bus.on(['playhead', 'view'], () => { if (app.groove.chart === 'midi') this.invalidate(); });
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
    if (app.groove.chart === 'midi') return this.transcript(w, h);
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

  /**
   * The hits as MIDI notes over time: the loop when it is on, else what the editor shows, so the
   * transcript scrolls with playback. Bar and beat lines come from the tempo map when there is one.
   * Everything is placed by the timeline, as in the editor: heard warped, a note is where the warp puts
   * its hit, so a quantized hit sits on its line.
   */
  private transcript(w: number, h: number): void {
    const { g, C, app } = this, notes = app.drumNotes;
    if (!notes.length) {
      g.fillStyle = C.dim; g.textAlign = 'center';
      g.fillText(app.drums ? 'No hits at these sensitivities' : app.audio ? 'Finding the drums…' : '', w / 2, h / 2);
      g.textAlign = 'left';
      return;
    }
    const tl = app.timeline, loop = app.activeLoop;
    const range = loop ? { a: tl.axisAt(loop.a), b: tl.axisAt(loop.b) } : { a: app.view.t0, b: app.view.t1 };
    const L = LABEL_W + 4, R = w - 8, t0 = range.a, span = Math.max(1e-3, range.b - range.a);
    const xOf = (t: number) => L + ((t - t0) / span) * (R - L), axisY = h - BOTTOM + 4;
    const rh = (h - TOP - BOTTOM) / ROWS.length;
    g.save();
    g.beginPath(); g.rect(L, 0, R - L, h); g.clip();
    ROWS.forEach((_, i) => { if (i % 2) { g.fillStyle = rgba(C.ink, 0.035); g.fillRect(L, TOP + rh * i, R - L, rh); } });
    // Grid: steps faint, beats stronger, bars strongest with their numbers.
    const meter = app.doc.meter;
    let noteLen = 0.06;
    if (app.hasMap && !tl.map.isEmpty) {
      const bq = barQ(meter), btq = beatQ(meter), sq = GROOVE_GRID_Q[app.groove.grid];
      const q0 = tl.posAtAxis(t0), q1 = tl.posAtAxis(t0 + span);
      const pxQ = (R - L) / Math.max(1e-6, q1 - q0), unit = pxQ * sq >= 6 ? sq : pxQ * btq >= 6 ? btq : bq;
      g.font = '11px ' + FONT; g.textAlign = 'left';
      for (let k = Math.max(0, Math.floor(q0 / unit)); k * unit <= q1 + 1e-9 && k < 1e5; k++) {
        const q = k * unit, bar = Math.abs(q / bq - Math.round(q / bq)) < 1e-6, beat = Math.abs(q / btq - Math.round(q / btq)) < 1e-6;
        const x = Math.round(xOf(tl.axisOfPos(q))) + 0.5;
        g.strokeStyle = bar ? rgba(C.ink, 0.4) : beat ? rgba(C.ink, 0.18) : rgba(C.ink, 0.07);
        g.beginPath(); g.moveTo(x, TOP - 6); g.lineTo(x, axisY); g.stroke();
        if (bar) { g.fillStyle = C.ink; g.fillText(String(Math.round(q / bq) + 1), x + 3, axisY + 12); }
      }
      noteLen = tl.axisOfPos(q0 + sq) - tl.axisOfPos(q0);
    }
    // Notes: a step long, darker and taller the harder they were hit, lit while they sound.
    const ph = tl.axisAt(app.transport.playhead), nw = Math.max(3, Math.min(18, (noteLen / span) * (R - L) * 0.9));
    for (let i = lowerBound(notes, tl.sourceAt(t0 - noteLen)); i < notes.length && tl.axisAt(notes[i].t) < t0 + span; i++) {
      const n = notes[i], at = tl.axisAt(n.t), y = this.rowY(ROWS.indexOf(n.voice)), v = n.vel / 127, nh = Math.max(4, rh * (0.3 + 0.4 * v)), x = xOf(at);
      g.fillStyle = rgba(C[n.voice], 0.3 + 0.7 * v);
      g.beginPath(); if (g.roundRect) g.roundRect(x, y - nh / 2, nw, nh, 2); else g.rect(x, y - nh / 2, nw, nh); g.fill();
      if (ph >= at && ph < at + Math.max(0.08, noteLen)) { g.strokeStyle = C.ink; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1; }
    }
    if (ph >= t0 && ph <= t0 + span) {
      const x = Math.round(xOf(ph)) + 0.5;
      g.strokeStyle = C.play; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, TOP - 8); g.lineTo(x, axisY); g.stroke(); g.lineWidth = 1;
    }
    g.restore();
    ROWS.forEach((v, i) => {
      const y = this.rowY(i);
      g.fillStyle = C[v]; g.font = '600 12px ' + FONT; g.fillText(VOICE_LABEL[v].toUpperCase(), 4, y - 5);
      g.fillStyle = C.dim; g.font = '11px ' + FONT; g.fillText('note ' + GM_NOTE[v], 4, y + 8);
    });
    g.fillStyle = C.dim; g.font = '11px ' + FONT; g.textAlign = 'center';
    const shown = notes.length ? lowerBound(notes, t0 + span) - lowerBound(notes, t0) : 0;
    g.fillText(`MIDI transcript · ${shown} note${shown === 1 ? '' : 's'} ${app.activeLoop ? 'in the loop' : 'in view'}`, (L + R) / 2, 9);
    g.textAlign = 'left'; g.font = '12px ' + FONT;
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
