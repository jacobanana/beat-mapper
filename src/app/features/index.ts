import type { Analyzer } from '../../analysis/analyzer';
import type { App } from '../app';
import { Beats } from './beats';
import { Exports } from './exports';
import { Loader } from './loader';
import { Markers } from './markers';
import { Playback } from './playback';
import { type KeyValueStore, Sessions } from './sessions';
import { Slicer } from './slicer';
import { Workflow } from './workflow';

/** Every feature of the editor, wired to one App. The UI calls these; they change the App. */
export interface Features {
  playback: Playback;
  markers: Markers;
  beats: Beats;
  workflow: Workflow;
  exports: Exports;
  slicer: Slicer;
  sessions: Sessions;
  loader: Loader;
}

export function createFeatures(app: App, analyzer: Analyzer, store: KeyValueStore | null): Features {
  const playback = new Playback(app);
  const markers = new Markers(app, playback, analyzer);
  const beats = new Beats(app, playback);
  const workflow = new Workflow(app, beats);
  const exports = new Exports(app, beats);
  const slicer = new Slicer(app, playback, exports);
  const sessions = new Sessions(app, markers, playback, workflow, store);
  const loader = new Loader(app, analyzer, playback, sessions, workflow);
  return { playback, markers, beats, workflow, exports, slicer, sessions, loader };
}
