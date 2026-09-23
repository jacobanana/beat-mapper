# Warping

Once the beats are mapped, the tempo map says where every bar and beat falls in the audio. Warping
re-times the audio so that map becomes a straight grid: every bar the same length at one tempo. The
result is saved as a `.wav` from the Export window (**Audio → Warped to the grid**), ready to drop
into a DAW on bar 1 with no tempo map at all.

It is not a new step: everything it needs is already made in the Beats step (the map) and the
Transients step (where Drums mode cuts).

## Hearing it before saving

**Warped** in the Beats panel (or <kbd>W</kbd>) plays the warped audio in place of the original, with
the click on the straight grid, so what you hear is the file Export would save. The material and grid
tempo beside it are the Export window's own. The first play renders the warp in the worker; after
that the render is reused, for playing and for saving, until something it depends on changes (a pin,
the meter, the loop, the material, the grid tempo, the transients in Drums mode). An edit while
playing is rendered again once the edits settle, and playback carries on from the same place.

The editor stays on the original's timeline, so the playhead moves through the original: fast where
a bar is being slowed down, slow where it is sped up, and always on the hit you are hearing
(`Take` in `app/features/playback.ts` maps the two timelines both ways). The tempo lane draws the
grid's tempo as a dashed line, with the gap between each bar's tempo and it shaded: blue for a bar
that is slowed down, red for one sped up. Outside Beats, or with Warped off, the original plays.

## What gets warped

- **The loop, when it is on**: just the loop, starting the file, and exactly as many beats long as it
  holds at the new tempo. It is named like the loop export: `name_4bars_100bpm_warped.wav`.
- **Otherwise the whole file.** *Whole file + lead-in* keeps what comes before bar 1 and puts silence
  ahead of it so the file starts on a bar line; *Trim to bar 1* starts the file on bar 1.
- **Grid tempo**: empty takes the tempo the audio averages, to the nearest whole BPM. Type any other.
- Channels, normalizing and bit depth are the slicer's.

The tempo map is straight lines between pins, so moving each pin to where a steady tempo puts it
defines the warp exactly (`core/warp/map.ts`). Between pins the stretch is constant.

## One method per material

No single time-stretching method suits every sound ([Driedger & Müller 2016][review]). Each mode is
built on the one the literature finds best for its material.

| Material | Method | Good at | Costs |
| --- | --- | --- | --- |
| Drums | Cut at every transient, move each hit whole (REX, Ableton's Beats mode) | Attacks exact to the sample, sound untouched | Sustained sounds step; a gap is left when slowing down |
| Mono | WSOLA ([Verhelst & Roelands 1993][wsola]), 50 ms frames that may shift 12.5 ms to line up | Bass, lead, one note at a time: no phasing | Chords beat; attacks can double slightly |
| Vocal | WSOLA with 30 ms frames, 7.5 ms shift | Consonants stay crisp, formants stay put | Same as mono on dense material |
| Poly | Phase vocoder with identity phase locking ([Laroche & Dolson 1999][pv]), ~93 ms frames | Chords, pads, keys: smooth and in tune | Attacks soften |
| Full mix | Harmonic-percussive split by median filtering (Fitzgerald, DAFx 2010); harmonic part through the phase vocoder, percussive through short overlap-add (Driedger, Müller & Ewert, IEEE Signal Processing Letters 2014) | Whole songs: tonal parts smooth, hits sharp | Slower; a pitched drum (a kick's sweep) can split between the two |
| Re-pitch | Resampling, like a turntable | No artefacts at all | Pitch follows the tempo |

Stereo is kept together: WSOLA picks each frame's shift on the mix and applies it to both sides, and
the phase vocoder works out one set of phases on the mix, each side keeping its own offset from it.

The rendering runs in the analysis worker. On a three-minute stereo song, Drums and Re-pitch take
well under a second, Mono and Vocal a few seconds, Poly about 7 s and Full mix about 16 s in Node;
a loop takes a fraction of that.

## Tests

`test/warp.test.ts` checks that the map puts every pin on the grid, that every mode but Re-pitch
stretches a tone at its pitch and level, that stereo stays apart, and that the drifting demo's hits
land on a 120 BPM grid: to the sample in Drums and Re-pitch, within 2 ms in Full mix, and within a
frame's shift in the others.

## Later

- Quantizing the transients themselves to the grid (moving hits inside a beat, not only the beats).
- A view of the warped waveform itself, on the straight grid.
- Saving the warp settings with the session (they are kept for the visit only for now).
- Other stretchers worth trying: phase gradient heap integration ([Průša & Holighaus 2017][pghi]),
  which needs no peak picking or transient handling.

[review]: https://doi.org/10.3390/app6020057
[wsola]: https://www.semanticscholar.org/paper/An-overlap-add-technique-based-on-waveform-(WSOLA)-Verhelst-Roelands/d94abd77e52a56c425e4b86e6c7d692583ea406d
[pv]: https://www.semanticscholar.org/paper/Improved-phase-vocoder-time-scale-modification-of-Laroche-Dolson/8312d42cab3f14152d8e6406a9c0463737b6aa45
[pghi]: https://arxiv.org/abs/2202.07382
