// Warping: the audio re-timed so that the tempo map becomes a straight grid, saved as a .wav that
// drops into a DAW at a steady tempo. The loop, when it is on, is warped on its own.
import { fmtBpm, safeName } from '../../core/format';
import { renderSlice } from '../../core/slices/slices';
import { barQ } from '../../core/tempo/meter';
import { type WarpMap, averageBpm, planWarp, warpRange } from '../../core/warp/map';
import { WARP_MODE_INFO, type WarpMode } from '../../core/warp/modes';
import type { Analyzer } from '../../analysis/analyzer';
import { saveError, saveFile } from '../../io/download';
import { wavEncode } from '../../io/formats/wav';
import type { WarpSettings } from '../../state/settings';
import type { App } from '../app';
import type { Beats } from './beats';
import type { Slicer } from './slicer';

export interface WarpPlan {
  map: WarpMap;
  bpm: number;
  /** The tempo the part being warped averages. */
  avgBpm: number;
  /** Source seconds warped, and output seconds. */
  srcDur: number;
  outDur: number;
  /** The least and most anything is stretched: above 1 is slowed down. */
  ratios: [number, number];
  loop: boolean;
}

export class Warp {
  constructor(private readonly app: App, private readonly analyzer: Analyzer, private readonly beats: Beats, private readonly slicer: Slicer) {}

  update(patch: Partial<WarpSettings>): void { this.app.set('warp', patch); }

  /** What would be warped, and how, or null when there is no tempo map yet. */
  plan(): WarpPlan | null {
    const { app } = this;
    if (!app.audio || !app.hasMap) return null;
    const map = app.tempoMap, loop = app.activeLoop;
    const r = warpRange(map, app.doc.meter, app.dur, { lead: app.exportSettings.lead, loop });
    if (!(r.b - r.a > 0.01)) return null;
    const avgBpm = averageBpm(map, r), bpm = app.warp.bpm ?? Math.round(avgBpm);
    if (!(bpm > 0)) return null;
    const w = planWarp(map, r, bpm);
    return { map: w, bpm, avgBpm, srcDur: r.b - r.a, outDur: w.outDur, ratios: w.ratioRange(), loop: !!loop };
  }

  // Where Drums mode cuts: the transients of step 1, or the sixteenths of the tempo map when there are none.
  private transients(): number[] {
    const { app } = this, m = app.markers;
    if (m.length) return m.map((k) => k.t);
    const map = app.tempoMap, out: number[] = [];
    for (let q = Math.ceil(map.timeToPos(0) * 4) / 4; ; q += 0.25) {
      const t = map.posToTime(q);
      if (t >= app.dur || out.length > 100000) break;
      if (t >= 0) out.push(t);
    }
    return out;
  }

  /** name_warped_120bpm.wav, or name_4bars_120bpm_warped.wav for a loop, as loops are named. */
  fileName(p: WarpPlan): string {
    const base = safeName(this.app.audio?.name || 'audio') || 'audio';
    if (!p.loop) return `${base}_warped_${fmtBpm(p.bpm)}bpm.wav`;
    const bars = Math.max(1, Math.round((p.outDur * p.bpm) / 60 / barQ(this.app.doc.meter)));
    return `${base}_${bars}bar${bars === 1 ? '' : 's'}_${fmtBpm(p.bpm)}bpm_warped.wav`;
  }

  async save(): Promise<void> {
    const { app } = this, a = app.audio;
    if (!a) return app.notify.toast('Open an audio file first.');
    this.beats.ensureDownbeat();
    const p = this.plan();
    if (!p) return app.notify.toast('Set bar 1 and at least a tempo in step 2 first.');
    const mode: WarpMode = app.warp.mode, label = 'Warping · ' + WARP_MODE_INFO[mode].label;
    app.notify.busy(label, 0.01);
    try {
      const n = Math.max(1, Math.round(p.outDur * a.sr));
      // Only the part being warped goes to the worker, with half a second either side for the frames
      // that reach past its ends; times are moved to match.
      const len = a.chans[0].length, s0 = Math.max(0, Math.floor((p.map.src[0] - 0.5) * a.sr));
      const s1 = Math.min(len, Math.ceil((p.map.src[p.map.src.length - 1] + 0.5) * a.sr)), off = s0 / a.sr;
      const transients = mode === 'beats' ? this.transients().filter((t) => t >= off && t < s1 / a.sr).map((t) => t - off) : [];
      const chans = await this.analyzer.warp(
        { chans: a.chans.map((c) => c.subarray(s0, s1)), sr: a.sr, src: p.map.src.map((t) => t - off), dst: [...p.map.dst], n, mode, transients },
        (f) => app.notify.busy(label, 0.01 + 0.9 * f),
      );
      // Channels, level and bit depth as the slicer has them; a warped file is one long sample.
      const r = renderSlice(chans, a.sr, 0, n / a.sr, { ...this.slicer.renderOptions(), fadeIn: 0, fadeOut: 0 });
      app.notify.busy('Writing the .wav', 0.95);
      const bytes = wavEncode(r.chans, a.sr, app.slicer.bits);
      app.notify.idle();
      const res = await saveFile(this.fileName(p), bytes as BlobPart, 'audio/wav');
      app.notify.toast(res.ok ? `Warped to ${fmtBpm(p.bpm)} BPM and saved.` : saveError(res.code, 'Too large for this viewer. Loop a shorter part, or use 16-bit mono.'));
    } catch (e) {
      console.error(e);
      app.notify.idle();
      app.notify.toast("Couldn't warp the audio – loop a shorter part and try again.");
    }
  }
}
