// The Notes step's chart: the notes found, as a piano roll under a moving playhead. The loop when it
// is on, else what the editor shows, so it scrolls with playback; bar and beat lines from the tempo
// map. Everything is placed by the timeline, as in the editor, so heard warped a note is where the
// warp puts it. Tap a note to select it and put the playhead on it; double-tap it to delete it.
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import type { HeardNote } from '../../core/notes/select';
import { noteName } from '../../core/notes/types';
import { lowerBound } from '../../core/search';
import { barQ, beatQ } from '../../core/tempo/meter';
import { type Colors, FONT, readColors, rgba } from './theme';

const LABEL_W = 36, TOP = 18, BOTTOM = 20;
const BLACK = new Set([1, 3, 6, 8, 10]);

export class PianoRoll {
  private readonly g: CanvasRenderingContext2D;
  private C: Colors = readColors();
  private queued = false;
  /** Where each note was drawn, for the pointer. */
  private boxes: { x0: number; x1: number; y0: number; y1: number; n: HeardNote }[] = [];
  private lastTap = { t: 0, key: '' };

  constructor(private readonly cv: HTMLCanvasElement, private readonly app: App, private readonly f: Features) {
    this.g = cv.getContext('2d')!;
    app.bus.on(['transcript', 'notes', 'doc', 'transport', 'step', 'audio', 'beats', 'heard', 'selection', 'playhead', 'view'], () => this.invalidate());
    cv.addEventListener('pointerdown', (e) => this.tap(e));
  }

  /** Redraws on the next frame, once however many changes come in before it. */
  invalidate(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.draw(); });
  }

  recolor(): void { this.C = readColors(); this.invalidate(); }

  private tap(e: PointerEvent): void {
    const r = this.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    // The nearest note under the pointer, with a few pixels of slack for a finger.
    const pad = e.pointerType === 'touch' ? 8 : 3;
    const hit = this.boxes.find((b) => x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad);
    if (!hit) return;
    const key = hit.n.pitch + '@' + hit.n.t, now = performance.now();
    if (key === this.lastTap.key && now - this.lastTap.t < 350) { this.f.notes.removeNote(hit.n.pitch, hit.n.t); this.lastTap = { t: 0, key: '' }; return; }
    this.lastTap = { t: now, key };
    this.f.notes.selectNote(hit.n.pitch, hit.n.t);
  }

  draw(): void {
    const { cv, g, app, C } = this;
    if (cv.offsetParent === null) return; // hidden: drawn when the step opens
    const dpr = Math.max(1, window.devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = '12px ' + FONT;
    g.textBaseline = 'middle';
    this.boxes = [];
    const notes = app.heardNotes;
    if (!notes.length) {
      g.fillStyle = C.dim; g.textAlign = 'center';
      g.fillText(app.transcript ? 'No notes at this sensitivity' : app.audio ? 'Finding the notes…' : '', w / 2, h / 2);
      g.textAlign = 'left';
      return;
    }
    // The pitches shown: every note of the take, with a little room, at least an octave.
    let lo = 127, hi = 0;
    for (const n of notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
    lo = Math.max(0, lo - 1); hi = Math.min(127, hi + 1);
    while (hi - lo < 12) { if (lo > 0) lo--; if (hi - lo < 12 && hi < 127) hi++; }
    const rows = hi - lo + 1, rh = (h - TOP - BOTTOM) / rows, yOf = (p: number) => TOP + (hi - p) * rh;

    const tl = app.timeline, loop = app.activeLoop;
    const range = loop ? { a: tl.axisAt(loop.a), b: tl.axisAt(loop.b) } : { a: app.view.t0, b: app.view.t1 };
    const L = LABEL_W + 4, R = w - 8, t0 = range.a, span = Math.max(1e-3, range.b - range.a);
    const xOf = (t: number) => L + ((t - t0) / span) * (R - L), axisY = h - BOTTOM + 4;
    g.save();
    g.beginPath(); g.rect(L, 0, R - L, h); g.clip();
    // The black keys' rows shaded, a line under every C.
    for (let p = lo; p <= hi; p++) {
      if (BLACK.has(p % 12)) { g.fillStyle = rgba(C.ink, 0.045); g.fillRect(L, yOf(p), R - L, rh); }
      if (p % 12 === 0) { g.fillStyle = rgba(C.ink, 0.14); g.fillRect(L, Math.round(yOf(p) + rh) - 0.5, R - L, 1); }
    }
    // Grid: beats faint, bars stronger with their numbers.
    const meter = app.doc.meter;
    if (app.hasMap && !tl.map.isEmpty) {
      const bq = barQ(meter), btq = beatQ(meter), q0 = tl.posAtAxis(t0), q1 = tl.posAtAxis(t0 + span);
      const pxQ = (R - L) / Math.max(1e-6, q1 - q0), unit = pxQ * btq >= 8 ? btq : bq;
      g.font = '11px ' + FONT;
      for (let k = Math.max(0, Math.floor(q0 / unit)); k * unit <= q1 + 1e-9 && k < 1e5; k++) {
        const q = k * unit, bar = Math.abs(q / bq - Math.round(q / bq)) < 1e-6, x = Math.round(xOf(tl.axisOfPos(q))) + 0.5;
        g.strokeStyle = bar ? rgba(C.ink, 0.35) : rgba(C.ink, 0.12);
        g.beginPath(); g.moveTo(x, TOP - 4); g.lineTo(x, axisY); g.stroke();
        if (bar) { g.fillStyle = C.ink; g.fillText(String(Math.round(q / bq) + 1), x + 3, axisY + 10); }
      }
    }
    // Notes: as long as they are held, darker the louder, lit while they sound; a bend drawn through
    // the note, a row a semitone.
    const ph = tl.axisAt(app.transport.playhead), sel = app.sel?.kind === 'note' ? app.sel : null;
    const first = Math.max(0, lowerBound(notes, tl.sourceAt(t0 - 8)));
    for (let i = first; i < notes.length && tl.axisAt(notes[i].t) < t0 + span; i++) {
      const n = notes[i], a = tl.axisAt(n.t), b = tl.axisAt(n.end);
      if (b < t0) continue;
      const x0 = xOf(a), x1 = Math.max(x0 + 3, xOf(b)), y = yOf(n.pitch), v = n.vel / 127, nh = Math.max(3, rh - 1);
      g.fillStyle = rgba(C.slice, 0.35 + 0.65 * v);
      g.beginPath(); if (g.roundRect) g.roundRect(x0, y + 0.5, x1 - x0, nh, 2); else g.rect(x0, y + 0.5, x1 - x0, nh); g.fill();
      const on = ph >= a && ph < b, picked = sel && sel.pitch === n.pitch && sel.t === n.t;
      if (on || picked) { g.strokeStyle = C.ink; g.lineWidth = picked ? 2 : 1.2; g.stroke(); g.lineWidth = 1; }
      if (n.bend?.length) {
        g.strokeStyle = rgba(C.ink, 0.6); g.lineWidth = 1.2; g.beginPath();
        g.moveTo(x0, y + rh / 2);
        for (const p of n.bend) g.lineTo(xOf(tl.axisAt(p.t)), y + rh / 2 - (p.cents / 100) * rh);
        g.stroke(); g.lineWidth = 1;
      }
      this.boxes.push({ x0, x1, y0: y, y1: y + nh, n });
    }
    if (ph >= t0 && ph <= t0 + span) {
      const x = Math.round(xOf(ph)) + 0.5;
      g.strokeStyle = C.play; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, TOP - 6); g.lineTo(x, axisY); g.stroke(); g.lineWidth = 1;
    }
    g.restore();
    // Note names at the left: every C, and the lowest and highest rows, as far as there is room.
    g.font = '11px ' + FONT; g.fillStyle = C.dim;
    const every = rh >= 11 ? 1 : rh >= 5 ? 12 : 24;
    for (let p = lo; p <= hi; p++) {
      if (every === 1 ? !BLACK.has(p % 12) : p % every === 0) g.fillText(noteName(p), 4, yOf(p) + rh / 2);
    }
    g.textAlign = 'center';
    const shown = this.boxes.length, n0 = app.selectedNote();
    g.fillText(n0 ? `${noteName(n0.pitch)} selected · Del deletes it` : `${shown} note${shown === 1 ? '' : 's'} ${loop ? 'in the loop' : 'in view'}`, (L + R) / 2, 8);
    g.textAlign = 'left'; g.font = '12px ' + FONT;
  }
}
