// A small synth voice, to hear the notes the Notes step found: a sawtooth and a sine an octave down
// through a low-pass that closes as the note decays, like a plain analogue bass or keys patch. Each
// note is a handful of nodes that stop by themselves, so scheduling one is fire-and-forget.
import { audioContext } from './audio-context';

export interface SynthNote {
  pitch: number;
  /** Seconds the note is held. */
  dur: number;
  /** MIDI velocity. */
  vel: number;
  /** Bend points: seconds after the start, cents off the note. */
  bend?: readonly { at: number; cents: number }[];
}

/** Plays one note at context time `when` into `dest`. */
export function synthNote(n: SynthNote, when: number, dest?: AudioNode): void {
  const c = audioContext(), f = 440 * Math.pow(2, (n.pitch - 69) / 12), dur = Math.max(0.03, n.dur), rel = 0.06;
  // Velocity to gain squared, as the kit does; lower notes a little louder, as small speakers lose them.
  const g = Math.pow(Math.max(1, Math.min(127, n.vel)) / 127, 2) * 0.32 * (n.pitch < 48 ? 1.3 : 1);
  const out = c.createGain(), lp = c.createBiquadFilter(), saw = c.createOscillator(), sub = c.createOscillator(), subG = c.createGain();
  saw.type = 'sawtooth';
  saw.frequency.value = f;
  sub.type = 'sine';
  sub.frequency.value = f / 2;
  subG.gain.value = n.pitch < 52 ? 0.5 : 0.25;
  lp.type = 'lowpass';
  lp.Q.value = 2;
  lp.frequency.setValueAtTime(Math.min(12000, f * 8), when);
  lp.frequency.exponentialRampToValueAtTime(Math.min(12000, f * 2.5), when + Math.min(dur, 0.4));
  // A 4 ms attack, a fall to 70% over the first 300 ms (or as much of it as the note lasts), held, and
  // a 60 ms release: every step a plain ramp, so the level at the release is known.
  const d = Math.min(dur, 0.3), held = g * (1 - (0.3 * d) / 0.3);
  out.gain.setValueAtTime(0, when);
  out.gain.linearRampToValueAtTime(g, when + 0.004);
  out.gain.linearRampToValueAtTime(held, when + Math.max(0.005, d));
  out.gain.setValueAtTime(held, when + dur);
  out.gain.linearRampToValueAtTime(0, when + dur + rel);
  for (const b of n.bend ?? []) {
    if (b.at <= 0 || b.at >= dur) continue;
    saw.detune.setValueAtTime(b.cents, when + b.at);
    sub.detune.setValueAtTime(b.cents, when + b.at);
  }
  saw.connect(lp);
  sub.connect(subG).connect(lp);
  lp.connect(out).connect(dest ?? c.destination);
  for (const o of [saw, sub]) { o.start(when); o.stop(when + dur + rel + 0.02); }
}
