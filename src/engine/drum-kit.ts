// A small synthesised kit, to hear the drums the Groove step found: a pitch-swept sine for the kick,
// a tone and filtered noise for the snare, bright noise for the hats. Each hit is a handful of nodes
// that stop by themselves, so scheduling one is fire-and-forget.
import type { Voice } from '../core/drums/voices';
import { audioContext } from './audio-context';

let noise: AudioBuffer | null = null;

// One second of white noise, made once per context and shared by every snare and hat.
function noiseBuffer(c: BaseAudioContext): AudioBuffer {
  if (noise && noise.sampleRate === c.sampleRate) return noise;
  const b = c.createBuffer(1, c.sampleRate, c.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return (noise = b);
}

/** Plays one hit of `voice` at context time `when`, as loud as MIDI velocity `vel` says. */
export function drumHit(voice: Voice, when: number, vel: number): void {
  const c = audioContext(), out = c.createGain();
  // Velocity to gain as a drum machine does it: squared, so ghost notes sit well below the accents.
  out.gain.value = Math.pow(Math.max(1, Math.min(127, vel)) / 127, 2) * 0.9;
  out.connect(c.destination);
  if (voice === 'kick') kick(c, out, when);
  else if (voice === 'snare') snare(c, out, when);
  else hat(c, out, when);
}

function env(c: BaseAudioContext, when: number, peak: number, decay: number): GainNode {
  const e = c.createGain();
  e.gain.setValueAtTime(0, when);
  e.gain.linearRampToValueAtTime(peak, when + 0.002);
  e.gain.exponentialRampToValueAtTime(0.0005, when + decay);
  return e;
}

function kick(c: BaseAudioContext, out: AudioNode, when: number): void {
  const o = c.createOscillator(), e = env(c, when, 1, 0.4);
  o.frequency.setValueAtTime(160, when);
  o.frequency.exponentialRampToValueAtTime(48, when + 0.12);
  o.connect(e).connect(out);
  o.start(when);
  o.stop(when + 0.42);
}

function snare(c: BaseAudioContext, out: AudioNode, when: number): void {
  const o = c.createOscillator(), oe = env(c, when, 0.5, 0.1);
  o.type = 'triangle';
  o.frequency.setValueAtTime(220, when);
  o.frequency.exponentialRampToValueAtTime(170, when + 0.08);
  o.connect(oe).connect(out);
  o.start(when);
  o.stop(when + 0.12);
  const n = c.createBufferSource(), f = c.createBiquadFilter(), ne = env(c, when, 0.7, 0.2);
  n.buffer = noiseBuffer(c);
  f.type = 'highpass';
  f.frequency.value = 1200;
  n.connect(f).connect(ne).connect(out);
  n.start(when);
  n.stop(when + 0.22);
}

function hat(c: BaseAudioContext, out: AudioNode, when: number): void {
  const n = c.createBufferSource(), f = c.createBiquadFilter(), e = env(c, when, 0.45, 0.05);
  n.buffer = noiseBuffer(c);
  f.type = 'highpass';
  f.frequency.value = 7500;
  n.connect(f).connect(e).connect(out);
  // Start somewhere different in the noise each time, so repeated hats don't sound identical.
  n.start(when, Math.random() * 0.9);
  n.stop(when + 0.06);
}
