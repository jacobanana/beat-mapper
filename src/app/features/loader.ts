// Opening audio: decode, analyse (in the worker), pick up any saved session.
import { estimateTempo } from '../../core/dsp/tempo';
import { synthDemo } from '../../core/demo';
import type { Analyzer } from '../../analysis/analyzer';
import { audioContext, channelsOf, decodeAudio } from '../../engine/audio-context';
import { emptyDoc } from '../../state/project';
import { type App } from '../app';
import { makeAsset } from '../audio-asset';
import type { Playback } from './playback';
import type { Sessions } from './sessions';
import type { Workflow } from './workflow';

export class Loader {
  constructor(
    private readonly app: App,
    private readonly analyzer: Analyzer,
    private readonly playback: Playback,
    private readonly sessions: Sessions,
    private readonly workflow: Workflow,
  ) {}

  private busy(text: string, f: number): void {
    this.app.busy = true;
    this.app.notify.busy(text, f);
  }

  async loadFile(file: File): Promise<void> {
    try {
      this.playback.stop(true);
      this.busy('Reading audio', 0.02);
      const data = await file.arrayBuffer();
      this.busy('Decoding audio', 0.06);
      const buf = await decodeAudio(data);
      await this.open(buf, file.name.replace(/\.[^.]+$/, ''), file.name, file);
    } catch (e) {
      console.error(e);
      this.app.busy = false;
      this.app.notify.idle();
      this.app.notify.toast("Couldn't decode that file. Try WAV, MP3, M4A or FLAC.");
    }
  }

  /** A synthetic drum loop whose tempo drifts: something to try every step on. */
  async loadDemo(): Promise<void> {
    this.playback.stop(true);
    this.busy('Building the drum loop', 0.05);
    await new Promise((r) => setTimeout(r, 20));
    const sr = 44100, d = synthDemo(sr), buf = audioContext().createBuffer(1, d.x.length, sr);
    buf.getChannelData(0).set(d.x);
    await this.open(buf, 'drifting-drum-loop', 'drifting-drum-loop.wav', null);
  }

  /** Makes decoded audio the one being worked on: analyses it, resets the work, restores its session. */
  async open(buf: AudioBuffer, name: string, fileName: string, file: File | null): Promise<void> {
    const { app } = this;
    const asset = makeAsset(buf, channelsOf(buf), name, fileName, file);
    const analysis = await this.analyzer.analyze(asset.x, asset.sr, (f) => this.busy('Finding transients', 0.1 + 0.88 * f));
    const cands = await this.analyzer.candidates(app.detection.band, app.detection.algo);

    app.audio = asset;
    app.analysis = analysis;
    app.cands = cands;
    app.doc = emptyDoc(+estimateTempo(analysis.odfs.flux.full, analysis.fr).toFixed(2));
    app.history.clear();
    app.sel = null;
    app.hover = null;
    app.excluded = [];
    app.sliceSel = null;
    app.amp = 1;
    app.view.reset(asset.dur);
    app.transport = { ...app.transport, playhead: 0, start: 0, loop: null, loopOn: false };
    app.busy = false;
    app.notify.idle();
    app.bus.emit('audio', 'doc', 'candidates', 'transport', 'view', 'playhead', 'selection', 'slices');
    this.workflow.goTo(1);
    await this.sessions.restore();
  }
}
