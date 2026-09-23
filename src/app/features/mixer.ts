// The mixer: how loud the audio, the metronome and the synth kit are. The levels belong to this
// device (headphones, speakers), not to the work on a file, so they are kept apart from sessions.
import { MIX_MAX, type MixSettings, parseMix } from '../../state/settings';
import type { App } from '../app';
import type { KeyValueStore } from './sessions';

const MIX_KEY = 'beatmapper:mix';

export type MixChannel = keyof MixSettings;

export class Mixer {
  constructor(private readonly app: App, private readonly store: KeyValueStore | null) {
    let saved: string | null = null;
    try { saved = store?.getItem(MIX_KEY) ?? null; } catch {}
    app.set('mix', parseMix(saved));
  }

  /** Sets a channel's level, in percent of its natural level. */
  setLevel(ch: MixChannel, v: number): void {
    const level = Math.max(0, Math.min(MIX_MAX, Math.round(v)));
    if (this.app.mix[ch] === level) return;
    this.app.set('mix', { [ch]: level });
    try { this.store?.setItem(MIX_KEY, JSON.stringify(this.app.mix)); } catch {}
  }
}
