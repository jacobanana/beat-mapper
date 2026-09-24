// Keyboard shortcuts. The full list is in the help dialog (index.html).
import type { App } from '../../app/app';
import type { Features } from '../../app/features';
import { $ } from '../dom';

export interface KeyboardHooks {
  openHelp(): void;
  openFile(): void;
  openExport(): void;
  refocus(): void;
  canvas: HTMLCanvasElement;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function bindKeyboard(app: App, f: Features, hooks: KeyboardHooks): void {
  const { canvas: cv } = hooks;
  const zoomKey = (k: number) => {
    const v = app.view, tc = v.contains(app.transport.playhead) ? app.transport.playhead : (v.t0 + v.t1) / 2;
    v.zoomAt(k, tc);
    app.bus.emit('view');
  };

  window.addEventListener('keydown', (e) => {
    const el = document.activeElement as HTMLElement | null, tag = el?.tagName;
    const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['range', 'checkbox', 'radio'].includes((el as HTMLInputElement).type));
    if (['help', 'exportDlg', 'confirmDlg'].some((id) => ($(id) as HTMLDialogElement).open)) return;
    if (typing) { if (e.key === 'Escape' || e.key === 'Enter') { el!.blur(); hooks.refocus(); } return; }
    const mod = e.metaKey || e.ctrlKey, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (mod) {
      if (k === 'z') { e.preventDefault(); undoRedo(e.shiftKey); }
      else if (k === 'y') { e.preventDefault(); undoRedo(true); }
      else if (k === 'e') { e.preventDefault(); hooks.openExport(); }
      else if (k === 'o') { e.preventDefault(); hooks.openFile(); }
      return;
    }
    if (k === 'Tab') {
      if (el === cv) { e.preventDefault(); if (app.step === 4) f.slicer.tab(e.shiftKey ? -1 : 1); else f.markers.tab(e.shiftKey ? -1 : 1); }
      return;
    }
    if (k === ' ') { if (tag === 'BUTTON') return; e.preventDefault(); f.playback.togglePlay(e.shiftKey); return; }
    if (!app.audio) { if (k === '?') hooks.openHelp(); return; }
    const done = () => e.preventDefault();

    switch (k) {
      case 'ArrowLeft': case 'ArrowRight': if (tag === 'INPUT') return; nudge((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.01 : e.altKey ? 0.0001 : 0.001)); return done();
      case 'ArrowUp': app.amp = clamp(app.amp * 1.25, 0.25, 32); app.bus.emit('display'); return done();
      case 'ArrowDown': app.amp = clamp(app.amp / 1.25, 0.25, 32); app.bus.emit('display'); return done();
      case '+': case '=': zoomKey(0.5); return done();
      case '-': case '_': zoomKey(2); return done();
      case 'z': app.setView(0, app.dur); return;
      case 'Home': f.playback.seek(0); app.reveal(0); return done();
      case 'End': f.playback.seek(app.dur); app.reveal(app.dur); return done();
      case 'Enter': if (tag === 'BUTTON' || tag === 'LABEL') return; f.playback.playFromStart(e.shiftKey); return done();
      case 'l': f.playback.toggleLoop(); return;
      case 'i': f.playback.setLoopEdge('a'); return;
      case 'o': f.playback.setLoopEdge('b'); return;
      case 'p': f.playback.setStartHere(); return;
      case 'r': f.playback.toggleScrub(); return;
      case ',': case '<': f.playback.stepListen(-1, e.shiftKey); return done();
      case '.': case '>': f.playback.stepListen(1, e.shiftKey); return done();
      case 'h': f.playback.toggleStay(); return;
      case 'v': f.markers.toggleOdf(); return;
      case 'k': f.playback.toggleClick(); return;
      case 'w': f.warp.toggleListen(); return;
      case '1': case '2': case '3': case '4': case '5': f.workflow.goTo(+k as 1 | 2 | 3 | 4 | 5); return;
      case '?': hooks.openHelp(); return;
      case 'Escape': app.select(null); if (el === cv) cv.blur(); return;
      case 'Delete': case 'Backspace': {
        const m = app.selectedMarker(), a = app.selectedAnchor(), h = app.selectedHit();
        if (m && app.step === 1) f.markers.remove(m);
        else if (a && app.step === 2) f.beats.unpin(a);
        else if (h && app.step === 5) f.groove.removeHit(h.voice, h.t);
        else if (app.step === 3 && f.warp.selected() != null) f.warp.removeSelected();
        return done();
      }
    }
    if (app.step === 1) {
      if (k === 'a') f.markers.add(app.transport.playhead);
      else if (k === '[' || k === ']') f.markers.setSensitivity(app.detection.sens + (k === ']' ? 2 : -2));
    } else if (app.step === 2) {
      if (k === 'd') f.beats.setDownbeat(app.transport.playhead);
      else if (k === 'b') f.beats.pinAt(app.transport.playhead);
      else if (k === 'm') f.beats.autoMap();
      else if (k === 'f') { if (e.shiftKey) f.beats.steadyFromLoop(); else f.beats.deriveFromLoop(); }
      else if (k === 'g') f.beats.cycleGrid(e.shiftKey ? -1 : 1);
      else if (k === 't') f.beats.tap();
      else if (k === 's') f.beats.cycleSnap(e.shiftKey ? -1 : 1);
    } else if (app.step === 3) {
      if (k === 'f') f.warp.fromLoop();
      else if (k === 'q') f.warp.toggleQuantize();
      else if (k === 'g') f.beats.cycleGrid(e.shiftKey ? -1 : 1);
    } else if (app.step === 4) {
      if (k === 'e') f.slicer.previewSelected();
      else if (k === 'x') f.slicer.toggleSelected();
    } else if (app.step === 5) {
      if (k === 'x') f.groove.toggleExaggerate();
      else if (k === 'm') {
        f.mixer.toggleMute('drums');
        if (app.drums) app.notify.toast(app.mute.drums ? 'Synth kit: muted' : 'Synth kit: on');
      }
      else if (k === 'c') f.groove.toggleChart();
    }
  });

  function undoRedo(redo: boolean): void {
    if (redo) { if (!app.redo()) app.notify.toast('Nothing to redo'); }
    else if (!app.undo()) app.notify.toast('Nothing to undo');
  }

  /** ← →: moves the selected marker (Transients), pin or drum hit, or scrolls when nothing is selected. */
  function nudge(dt: number): void {
    if (!app.sel) {
      const sp = app.view.span;
      app.setView(app.view.t0 + Math.sign(dt) * sp * 0.1, app.view.t1 + Math.sign(dt) * sp * 0.1);
      return;
    }
    const m = app.selectedMarker(), a = app.selectedAnchor();
    if (m) { if (app.step === 1) f.markers.nudge(m, dt); }
    else if (a) f.beats.nudge(a, dt);
    else if (app.step === 5) f.groove.nudgeSelected(dt);
  }
}
