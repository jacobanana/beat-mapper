// Sessions: the work on each audio file is kept in this browser and comes back when the same file is
// opened again; a session file carries it to another device. Neither ever holds audio.
import { safeName } from '../../core/format';
import { matchRemoved } from '../../core/markers/detect';
import { saveError, saveFile } from '../../io/download';
import { type SessionContent, isSessionJson, parseSession, toSessionJson } from '../../io/session';
import type { ProjectDoc } from '../../state/project';
import type { App } from '../app';
import type { Markers } from './markers';
import type { Playback } from './playback';
import type { Workflow } from './workflow';

const INDEX_KEY = 'beatmapper:index';
/** How many files' sessions are kept in the browser. */
const KEEP = 8;

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export class Sessions {
  private lastSaved = '';
  /** A session file opened before its audio: applied when the audio arrives. */
  private pending: unknown = null;

  constructor(
    private readonly app: App,
    private readonly markers: Markers,
    private readonly playback: Playback,
    private readonly workflow: Workflow,
    private readonly store: KeyValueStore | null,
  ) {}

  private key(): string {
    const a = this.app.audio!;
    return `beatmapper:s:${a.fileName || a.name}|${Math.round(a.dur * 1000)}`;
  }

  /** The current work as a session. */
  content(): SessionContent {
    const { app } = this, a = app.audio!, t = app.transport;
    return {
      audio: { name: a.name, fileName: a.fileName, duration: a.dur, sampleRate: a.sr },
      detection: app.detection,
      markers: {
        manual: app.doc.markers.manual.map((m) => m.t),
        // Only removals that still hit a candidate; stale ones would pile up.
        removed: app.cands.filter((c) => app.doc.markers.removed.includes(c.t)).map((c) => c.t),
      },
      meter: app.doc.meter,
      tempo: { anchors: [...app.doc.tempo.anchors], baseBpm: app.doc.tempo.baseBpm },
      beats: { grid: app.beats.grid, mapEvery: app.beats.mapEvery, tol: app.beats.tol, snapTo: app.beats.snapTo },
      transport: { loop: t.loop, loopOn: t.loopOn, start: t.start, playhead: this.playback.playing ? t.start : t.playhead, stay: t.stay, click: t.click },
      view: app.view.range,
      step: app.step,
      export: app.exportSettings,
      slicer: app.slicer,
      excluded: app.excluded,
    };
  }

  /** Writes the session to the browser if it changed. Runs every 1.5 s and when the page hides. */
  autosave(): void {
    const { app } = this;
    if (!app.audio || app.dragging || app.busy || !this.store) return;
    try {
      const js = JSON.stringify(toSessionJson(this.content()));
      if (js === this.lastSaved) return;
      this.lastSaved = js;
      const k = this.key();
      this.store.setItem(k, js);
      let idx: string[] = [];
      try { idx = JSON.parse(this.store.getItem(INDEX_KEY) || '[]'); } catch {}
      idx = [k, ...idx.filter((x) => x !== k)];
      for (const old of idx.splice(KEEP)) this.store.removeItem(old);
      this.store.setItem(INDEX_KEY, JSON.stringify(idx));
    } catch {}
  }

  /** Right after new audio is analysed: applies a pending session file, or the one saved for this file. */
  async restore(): Promise<void> {
    this.lastSaved = '';
    let d = this.pending, from: 'file' | 'saved' = 'file';
    this.pending = null;
    if (!d) {
      from = 'saved';
      try { const js = this.store?.getItem(this.key()); if (js) d = JSON.parse(js); } catch {}
    }
    if (!d || !isSessionJson(d)) return;
    try {
      const s = parseSession(d, this.app.dur, { band: this.app.detection.band, algo: this.app.detection.algo, baseBpm: this.app.doc.tempo.baseBpm });
      const off = Math.abs(s.audio.duration - this.app.dur) > 0.05;
      await this.apply(s);
      this.app.history.clear();
      this.app.notify.toast(off ? 'Session applied, but this audio has a different length – check the markers.' : from === 'saved' ? 'Picked up where you left off' : 'Session loaded');
    } catch (e) {
      console.error(e);
      this.app.notify.toast("Couldn't read that session.");
    }
  }

  private async apply(s: SessionContent): Promise<void> {
    const { app } = this, bandChanged = s.detection.band !== app.detection.band || s.detection.algo !== app.detection.algo;
    app.set('detection', s.detection);
    if (bandChanged) await this.markers.refreshCandidates();
    const manual = s.markers.manual.map((t, i) => ({ id: i + 1, t }));
    const doc: ProjectDoc = {
      meter: s.meter,
      tempo: s.tempo,
      markers: { manual, removed: matchRemoved(app.cands, s.markers.removed).map((i) => app.cands[i].t), nextId: manual.length + 1 },
    };
    app.edit(() => doc, false);
    app.set('beats', s.beats);
    app.set('transport', s.transport);
    app.set('export', s.export);
    app.set('slicer', s.slicer);
    app.excluded = s.excluded;
    app.sliceSel = null;
    app.select(null);
    this.workflow.goTo(s.step);
    if (s.view) app.setView(s.view.a, s.view.b);
    app.bus.emit('slices', 'playhead');
  }

  /** A session file picked or dropped: applied now, or once its audio is opened. */
  async import(file: File): Promise<void> {
    let d: unknown;
    try { d = JSON.parse(await file.text()); } catch { return this.app.notify.toast('That is not a BeatMapper session file.'); }
    if (!isSessionJson(d)) return this.app.notify.toast('That is not a BeatMapper session file.');
    this.pending = d;
    if (this.app.audio) await this.restore();
    else {
      const au = (d as { audio?: { fileName?: string; name?: string } }).audio;
      this.app.notify.toast('Session ready. Now open ' + ((au && (au.fileName || au.name)) || 'the audio') + '.');
    }
  }

  async export(): Promise<void> {
    const { app } = this;
    if (!app.audio) return app.notify.toast('Open an audio file first.');
    const name = safeName(app.audio.name || 'audio') + '-session.json', text = JSON.stringify(toSessionJson(this.content()), null, 1);
    const r = await saveFile(name, text, 'application/json');
    app.notify.toast(r.ok ? 'Session saved' : saveError(r.code, "This viewer couldn't save the file."));
  }
}

export const isSessionFile = (f: File): boolean => /\.json$/i.test(f.name) || f.type === 'application/json';
