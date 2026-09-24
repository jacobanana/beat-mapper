import type { App } from '../../app/app';
import type { Timeline } from '../../core/timeline';
import * as layers from './layers';
import { type Layout, layout } from './layout';
import { type Colors, readColors, rgba } from './theme';
import { renderWave } from './waveform';

/**
 * Draws the editor and overview canvases whenever something they show has changed, at most once
 * per animation frame. The waveform is cached as a bitmap and only re-rendered when the view,
 * size, height or colour changes.
 */
export class EditorRenderer {
  private dpr = 1;
  private C: Colors = readColors();
  private dirty = true;
  private waveKey = '';
  private waveView: Timeline | null = null;
  private readonly waveCache = document.createElement('canvas');
  private ovKey = '';
  private readonly ovCache = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private readonly og: CanvasRenderingContext2D;
  /** Finest grid level currently drawn; hit-testing grid lines uses it. */
  visLevel: 0 | 1 | 2 = 0;

  constructor(private readonly cv: HTMLCanvasElement, private readonly ov: HTMLCanvasElement, private readonly app: App) {
    this.g = cv.getContext('2d')!;
    this.og = ov.getContext('2d')!;
    app.bus.on('*', () => this.invalidate());
  }

  invalidate(): void { this.dirty = true; }

  /** Colours changed (theme switch). */
  recolor(): void {
    this.C = readColors();
    this.waveKey = this.ovKey = '';
    this.dirty = true;
  }

  resize(): void {
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    for (const c of [this.cv, this.ov]) {
      const w = Math.round(c.clientWidth * this.dpr), h = Math.round(c.clientHeight * this.dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    this.app.view.width = this.cv.clientWidth || 1;
    this.waveKey = this.ovKey = '';
    this.dirty = true;
  }

  get width(): number { return this.cv.clientWidth; }
  layout(): Layout { return layout(this.cv.clientWidth, this.cv.clientHeight, this.app.hasMap); }

  /** Draws if anything changed since the last frame. */
  frame(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
    this.drawOverview();
  }

  private draw(): void {
    const { g, app, dpr, C } = this, L = this.layout();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, L.w, L.h);
    const a = app.audio;
    if (!a) return;
    app.view.width = L.w || 1;
    // The only place the timeline meets pixels: layers get the audio's x and the grid's x, never the axis.
    const v = app.view, tl = app.timeline, moved = tl.movesAudio ? tl : null;
    const f: layers.Frame = {
      g, app, L, C, xOf: (t) => v.xOf(tl.axisAt(t)), xAtPos: (q) => v.xOf(tl.axisOfPos(q)), t0: tl.sourceAt(v.t0), t1: tl.sourceAt(v.t1),
      beatsMode: app.step >= 2, editable: app.step <= 3,
    };

    layers.background(f);
    if (app.hasMap) this.visLevel = layers.grid(f);

    const key = [v.t0, v.t1, this.cv.width, L.wh, app.amp, C.wave].join('|');
    if (key !== this.waveKey || moved !== this.waveView) {
      renderWave(this.waveCache, a, v.t0, v.t1, this.cv.width, Math.round(L.wh * dpr), app.amp, C.wave, dpr, moved);
      this.waveKey = key;
      this.waveView = moved;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.waveCache, 0, Math.round(L.wy * dpr));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    layers.odf(f);
    layers.slices(f);
    layers.markers(f);
    layers.drums(f);
    if (app.hasMap) layers.pins(f);
    if (app.hasMap) layers.warpMarkers(f);
    layers.tempoLane(f);
    layers.timeRuler(f);
    layers.loopStrip(f);
    layers.startFlag(f);
    layers.editHint(f);
    layers.playhead(f);
  }

  private drawOverview(): void {
    const { og, ov, app, C, dpr } = this, w = ov.clientWidth, h = ov.clientHeight, a = app.audio;
    og.setTransform(1, 0, 0, 1, 0, 0);
    og.clearRect(0, 0, ov.width, ov.height);
    if (!a) return;
    const key = [ov.width, ov.height, C.wave, a.name, a.dur].join('|');
    if (key !== this.ovKey) { renderWave(this.ovCache, a, 0, a.dur, ov.width, ov.height, 1, C.wave, dpr); this.ovKey = key; }
    og.globalAlpha = 0.55; og.drawImage(this.ovCache, 0, 0); og.globalAlpha = 1;
    og.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dur = a.dur, t = app.transport;
    og.fillStyle = rgba(C.beat, 0.7);
    for (const p of app.doc.tempo.anchors) og.fillRect((p.t / dur) * w, h - 4, 1, 4);
    // The overview is the audio as it is: the stretch of it in view, wherever the editor draws it.
    const tl = app.timeline, x0 = (tl.sourceAt(app.view.t0) / dur) * w, x1 = (tl.sourceAt(app.view.t1) / dur) * w;
    og.fillStyle = rgba(C.ink, 0.12); og.fillRect(x0, 0, Math.max(2, x1 - x0), h);
    og.strokeStyle = C.ink; og.lineWidth = 1; og.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0) - 1, h - 1);
    if (t.loop) { og.fillStyle = rgba(t.loopOn ? C.start : C.dim, 0.35); og.fillRect((t.loop.a / dur) * w, 0, Math.max(1, ((t.loop.b - t.loop.a) / dur) * w), 4); }
    og.fillStyle = C.start; og.fillRect((t.start / dur) * w - 1, h - 8, 2, 8);
    og.fillStyle = C.play; og.fillRect((t.playhead / dur) * w, 0, 1, h);
  }
}
