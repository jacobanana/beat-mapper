import type { Analyzer } from '../../analysis/analyzer';
import type { App } from '../app';
import { Beats } from './beats';
import { Exports } from './exports';
import { Groove } from './groove';
import { Loader } from './loader';
import { Markers } from './markers';
import { Mixer } from './mixer';
import { Playback } from './playback';
import { type KeyValueStore, Sessions } from './sessions';
import { Slicer } from './slicer';
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
  groove: Groove;
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
  const workflow = new Workflow(app, beats, groove);
  const slicer = new Slicer(app, playback, exports);
  const sessions = new Sessions(app, markers, playback, workflow, store);
  const loader = new Loader(app, analyzer, playback, sessions, workflow);
  return { playback, mixer, markers, beats, workflow, exports, slicer, groove, sessions, loader };
}
