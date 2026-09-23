import { App, type Notifier } from '../src/app/app';
import { type Features, createFeatures } from '../src/app/features';
import type { KeyValueStore } from '../src/app/features/sessions';
import { InlineAnalyzer } from '../src/analysis/analyzer';
import { synthDemo } from '../src/core/demo';

/** Enough of an AudioBuffer for everything but playback. */
export function fakeBuffer(chans: Float32Array[], sr: number): AudioBuffer {
  return { sampleRate: sr, duration: chans[0].length / sr, length: chans[0].length, numberOfChannels: chans.length, getChannelData: (i: number) => chans[i] } as unknown as AudioBuffer;
}

export class MemoryStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

export interface TestApp { app: App; f: Features; toasts: string[]; store: MemoryStore }

export function createTestApp(store = new MemoryStore()): TestApp {
  const toasts: string[] = [];
  const notify: Notifier = { toast: (m) => toasts.push(m), busy: () => {}, idle: () => {} };
  const app = new App(notify);
  app.view.width = 1000;
  const f = createFeatures(app, new InlineAnalyzer(false), store);
  return { app, f, toasts, store };
}

export const demo = synthDemo(44100);

export async function openDemo(t: TestApp): Promise<void> {
  await t.f.loader.open(fakeBuffer([demo.x], 44100), 'drifting-drum-loop', 'drifting-drum-loop.wav', null);
}
