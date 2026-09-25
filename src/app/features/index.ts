import type { Analyzer } from '../../analysis/analyzer';
import type { App } from '../app';
import { Beats } from './beats';
import { Exports } from './exports';
import { Groove } from './groove';
import { Loader } from './loader';
import { Markers } from './markers';
import { Mixer } from './mixer';
import { Notes } from './notes';
import { Playback } from './playback';
import { type KeyValueStore, Sessions } from './sessions';
import { Slicer } from './slicer';
import { Warp } from './warp';
import { WarpRender } from './warp-render';
import { Workflow } from './workflow';

/** Every feature of the editor, wired to one App. The UI calls these; they change the App. */
export interface Features {
  playback: Playback;
  mixer: Mixer;
  markers: Markers;
  beats: Beats;
  workflow: Workflow;
  exports: Exports;
  slicer: Slicer;
  warp: Warp;
  /** The warp rendered, and what plays following what is wanted. */
  warpRender: WarpRender;
  groove: Groove;
  notes: Notes;
  sessions: Sessions;
  loader: Loader;
}

export function createFeatures(app: App, analyzer: Analyzer, store: KeyValueStore | null): Features {
  const playback = new Playback(app);
  const mixer = new Mixer(app, store);
  const markers = new Markers(app, playback, analyzer);
  const beats = new Beats(app, playback);
  const exports = new Exports(app, beats);
  const groove = new Groove(app, analyzer, exports, playback);
  const notes = new Notes(app, analyzer, exports, playback);
  const warpRender = new WarpRender(app, analyzer, playback);
  const warp = new Warp(app, beats, warpRender);
  const slicer = new Slicer(app, playback, exports, warpRender);
  const workflow = new Workflow(app, markers, beats, slicer, warp, groove, notes);
  const sessions = new Sessions(app, markers, playback, workflow, store);
  const loader = new Loader(app, analyzer, playback, sessions, workflow);
  return { playback, mixer, markers, beats, workflow, exports, slicer, warp, warpRender, groove, notes, sessions, loader };
}
