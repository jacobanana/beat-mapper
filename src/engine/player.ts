import type { Voice } from '../core/drums/voices';
import type { TimeRange } from '../core/types';
import { audioContext } from './audio-context';
import { drumHit } from './drum-kit';

/** Calls `emit(time, downbeat)` for every click due in [a, b) of the audio's timeline. */
export type ClickSource = (a: number, b: number, emit: (t: number, down: boolean) => void) => void;
/** Calls `emit(time, voice, velocity)` for every drum hit due in [a, b) of the audio's timeline. */
export type HitSource = (a: number, b: number, emit: (t: number, voice: Voice, vel: number) => void) => void;

/** What plays along with the audio, and how loud the audio itself is, asked for as it plays. */
export interface PlayerSources {
  clicks: ClickSource;
  clicksOn(): boolean;
  hits: HitSource;
  hitsOn(): boolean;
  /** 0 mutes the audio, leaving only what plays along. */
  audioLevel(): number;
}

/**
 * Plays an AudioBuffer from a position, optionally looping a range, with a metronome scheduled a
 * little ahead of time on the audio clock, and drum hits the same way. Knows nothing about markers,
 * beats or drums: the times come from its sources.
 */
export class Player {
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private ctx0 = 0;
  private pos0 = 0;
  private loop: TimeRange | null = null;
  private schedE = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private level = 0.9;
  playing = false;
  /** Called when playback runs off the end of the audio. */
  onEnded: (() => void) | null = null;

  constructor(private readonly sources: PlayerSources) {}

  /** Starts playing buffer from `from` seconds; loops `loop` if given and `from` is before its end. */
  play(buffer: AudioBuffer, from: number, loop: TimeRange | null): void {
    this.halt();
    const c = audioContext();
    c.resume();
    const src = c.createBufferSource();
    src.buffer = buffer;
    this.gain = this.gain || c.createGain();
    this.gain.gain.cancelScheduledValues(0);
    this.gain.gain.value = this.level = this.sources.audioLevel();
    src.connect(this.gain).connect(c.destination);
    this.loop = loop && from < loop.b - 0.005 ? { a: loop.a, b: loop.b } : null;
    if (this.loop) { src.loop = true; src.loopStart = this.loop.a; src.loopEnd = this.loop.b; }
    this.ctx0 = c.currentTime + 0.03;
    this.pos0 = from;
    this.schedE = 0;
    src.start(this.ctx0, from);
    this.src = src;
    this.playing = true;
    src.onended = () => { if (this.src === src && this.playing) { this.halt(); this.onEnded?.(); } };
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  /** Stops, and returns where in the audio it was. */
  stop(): number {
    const p = this.position();
    this.halt();
    return p;
  }

  private halt(): void {
    if (this.src) {
      try { this.src.onended = null; this.src.stop(); } catch {}
      this.src = null;
    }
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Where in the audio the sound is at elapsed time e since the start. */
  private posAt(e: number): number {
    let p = this.pos0 + e;
    const L = this.loop;
    if (L && p >= L.b) p = L.a + ((p - L.b) % (L.b - L.a));
    return p;
  }

  /** Current position in the audio, seconds. */
  position(): number {
    return this.posAt(Math.max(0, audioContext().currentTime - this.ctx0));
  }

  // Clicks and hits are scheduled 160 ms ahead, walking the timeline piecewise so a loop's wrap is
  // followed. The audio's level is checked here too, so switching what is heard needs no restart.
  private schedule(): void {
    if (!this.playing) return;
    const c = audioContext(), eNow = c.currentTime - this.ctx0, S = this.sources;
    const lv = S.audioLevel();
    if (lv !== this.level && this.gain) { this.gain.gain.setTargetAtTime(lv, c.currentTime, 0.015); this.level = lv; }
    const clicks = S.clicksOn(), hits = S.hitsOn();
    if (!clicks && !hits) { this.schedE = eNow; return; }
    let ea = Math.max(this.schedE, eNow, 0);
    const eb = eNow + 0.16;
    let guard = 0;
    while (ea < eb - 1e-6 && guard++ < 64) {
      const p0 = this.posAt(ea);
      let len = eb - ea;
      if (this.loop && p0 < this.loop.b) len = Math.min(len, this.loop.b - p0);
      if (len < 1e-5) { ea += 1e-4; continue; }
      const e0 = ea;
      const at = (t: number) => Math.max(c.currentTime, this.ctx0 + e0 + (t - p0));
      if (clicks) S.clicks(p0, p0 + len, (t, down) => blip(at(t), down));
      if (hits) S.hits(p0, p0 + len, (t, voice, vel) => drumHit(voice, at(t), vel));
      ea += len;
    }
    this.schedE = eb;
  }
}

function blip(when: number, down: boolean): void {
  const c = audioContext(), o = c.createOscillator(), e = c.createGain();
  o.frequency.value = down ? 2100 : 1400;
  o.type = 'square';
  e.gain.setValueAtTime(0, when);
  e.gain.linearRampToValueAtTime(down ? 0.28 : 0.2, when + 0.001);
  e.gain.exponentialRampToValueAtTime(0.0008, when + 0.035);
  o.connect(e).connect(c.destination);
  o.start(when);
  o.stop(when + 0.05);
}

/** A short grain of the buffer from t, faded in and out: what scrubbing and stepping sound like. */
export function grain(buffer: AudioBuffer, t: number, len = 0.09): void {
  const c = audioContext();
  c.resume();
  const n = c.createBufferSource(), e = c.createGain(), now = c.currentTime;
  n.buffer = buffer;
  e.gain.setValueAtTime(0, now);
  e.gain.linearRampToValueAtTime(0.9, now + 0.005);
  e.gain.setValueAtTime(0.9, now + len - 0.025);
  e.gain.linearRampToValueAtTime(0, now + len);
  n.connect(e).connect(c.destination);
  n.start(now, Math.max(0, Math.min(Math.max(0, buffer.duration - 0.01), t)), len + 0.01);
}

/** Plays a one-off buffer (a rendered slice) and reports where in the source it is. */
export class OneShot {
  private cur: { src: AudioBufferSourceNode; t0: number; t1: number; c0: number } | null = null;

  get active(): boolean { return this.cur != null; }

  play(buffer: AudioBuffer, t0: number, t1: number, onEnded: () => void): void {
    this.stop();
    const c = audioContext();
    c.resume();
    const n = c.createBufferSource(), g = c.createGain();
    n.buffer = buffer;
    g.gain.value = 0.9;
    n.connect(g).connect(c.destination);
    const at = c.currentTime + 0.02;
    n.start(at);
    const cur = { src: n, t0, t1, c0: at };
    this.cur = cur;
    n.onended = () => { if (this.cur === cur) { this.cur = null; onEnded(); } };
  }

  /** Returns true if something was playing. */
  stop(): boolean {
    if (!this.cur) return false;
    try { this.cur.src.onended = null; this.cur.src.stop(); } catch {}
    this.cur = null;
    return true;
  }

  /** Position in the source audio, or null when idle. */
  position(): number | null {
    const p = this.cur;
    if (!p) return null;
    return Math.max(p.t0, Math.min(p.t1, p.t0 + Math.max(0, audioContext().currentTime - p.c0)));
  }
}
