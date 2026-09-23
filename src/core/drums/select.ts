import { detectMarkers } from '../markers/detect';
import { type DrumHit, type PerVoice, drumThreshold, perVoice } from './voices';

/**
 * The hits the sensitivity lets through, per voice: strong enough, and the strongest of any two a
 * voice has within `gap` seconds (a drummer can't play one drum twice in 30 ms; a flam is one hit).
 */
export function selectHits(all: PerVoice<readonly DrumHit[]>, sens: PerVoice<number>, gap = 0.03): PerVoice<DrumHit[]> {
  return perVoice((v) => detectMarkers(all[v], drumThreshold(sens[v]), gap).map((i) => all[v][i]));
}
