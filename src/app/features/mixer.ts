// The mixer: how loud the audio, the metronome, the synth kit and the synth voice are, and which are muted. The levels
// belong to this device (headphones, speakers), not to the work on a file, so they are kept apart
// from sessions. The mutes are not kept at all: a visit that starts silent looks broken.
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

  /** Whether a channel is heard. The click's mute is its on/off in the transport. */
  isOn(ch: MixChannel): boolean {
    return ch === 'click' ? this.app.transport.click : !this.app.mute[ch];
  }

  toggleMute(ch: MixChannel): void {
    if (ch === 'click') this.app.set('transport', { click: !this.app.transport.click });
    else this.app.set('mute', { [ch]: !this.app.mute[ch] });
    if (ch === 'drums' && !this.app.mute.drums && !this.app.drums) this.app.notify.toast('The kit plays the drums once they are found.');
    if (ch === 'notes' && !this.app.mute.notes && !this.app.transcript) this.app.notify.toast('The synth plays the notes once they are found.');
  }
}
