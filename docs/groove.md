# Groove: measuring the pocket

The Groove step answers the question Pocket Science [2] answers by ear: does the drummer play ahead of
the beat or behind it, and which drum? Here it is measured. Three stages, each in `src/core`:

```
audio ─▶ drums/detect.ts ─▶ hits per voice ─▶ drums/select.ts ─▶ groove/pocket.ts ─▶ pocket
          spectrogram, NMF,     (t, strength,      sensitivity,       grid step, offset
          pick, time, unbleed    loudness)          one per 30 ms     vs reference, stats
```

## 1. Finding kick, snare and hats (`core/drums/`)

A single stream of onsets can't show a pocket. The pocket is a relationship between voices, and on
the backbeat the snare and hat land within milliseconds of each other and would merge into one
marker. So each voice gets its own stream, as in automatic drum transcription generally [1].

- **Spectrogram** (`spectrogram.ts`): 23 ms windows every 5.8 ms, summed into quarter-octave bands.
- **NMF** (`nmf.ts`): the spectrogram is factorised into one spectral template and one activation
  per voice. When hits coincide their spectra add up, and each keeps its own activation. The
  templates start from priors and adapt to the kit (semi-adaptive, Dittmar & Gärtner 2014 [3]). Two
  choices matter more than any others; both were found by measuring the bleed between voices:
  - Each template is limited to its own frequency range (kick below 300 Hz, snare above 400 Hz,
    hats above 3 kHz). A snare template allowed down to 150 Hz learns the top of every kick's
    pitch sweep and fires on every kick.
  - The cost is squared error (β = 2 of the β-divergence [4]), not KL. KL charges almost nothing
    for predicting energy in a quiet band, which lets one voice explain another's attack.
- **Picking** (`detect.ts`): each activation's rises are that voice's hits. A bump on a
  decaying tail counts for less than a rise out of silence.
- **Timing**: each hit is placed at sample level (`dsp/refine.ts`) on a copy of the audio
  filtered to that voice's band with zero-phase filters. The corners are chosen so that the
  filters' pre-ringing moves no voice by more than 0.2 ms.
- **Bleed**: what is left of one voice in another is a steady fraction of the loud voice's
  level. That fraction is measured from the recording, and subtracted from each hit with a margin.

On the synthetic kit (`synthKit`: 8 bars, a pocket of kick −6 ms, snare +16 ms, ghosts +6 ms, hats
on the grid, each hit scattered ±2 ms), every kick, snare (ghost notes included) and hat is found,
90% of them to within 0.5 ms. The only misses are hats directly under a snare, which the snare's
wires mask.

## 2. The pocket (`core/groove/pocket.ts`)

Each hit goes to its nearest grid step on the tempo map (1/8, 1/16 or triplets) and is measured
from it. A map pinned to the transients is pinned to whatever hits first, so measuring against the
map alone is circular. Offsets are measured against a **reference** instead: by default the hats,
using their median offset on the eighths in each bar. Sixteenths may swing and swing isn't lean, so
they don't count towards the reference. A bar without the reference borrows it from its
neighbours. The reference can also be the kick, the snare, the whole kit, or the grid itself (for a
take played to a click).

Out of that: per voice, the median, spread and middle half of the offsets, and the swing (where the
odd steps fall between the even ones); per step, how often it is played, its median velocity and
lean. That per-step view is the typical bar. Velocities come from loudness against the voice's loud
hits, so a ghost note 16 dB down lands in the 50s.

## 3. Out

- **MIDI** (`io/formats/midi.ts`): the tempo map plus a drum track, every hit at the tick where
  it was played. It's exact when the export writes a tempo change at every pin. It writes the drums as
  they are heard in the Groove step: **quantize**, beside the grid there, moves every hit part or all
  of the way onto its step of the groove grid (`quantizeNotes` and `quantizedTime` in
  `groove/pocket.ts`), measured in time against the step, so the notes follow the tempo map. The
  synth kit, the MIDI transcript and this export follow it; the pocket is always measured as played.
  It starts at 0% (as played) and is saved with the session.
- **Groove file** (`io/formats/groove.ts`): the typical bar as a Pocket Science `groove-atlas-v2`
  pattern. It holds the steps played in at least half the bars, with offsets in ticks at 480 PPQ.
  `swing_16th` is null because the swing is already in the offsets.

## Full mixes: where this goes next

With **full mix** selected, the spectrogram keeps only its percussive part: a median-filter
harmonic/percussive split, FitzGerald 2010 [5], run in streaming form so memory stays flat. Eight free
NMF components absorb whatever is left of the other instruments (Wu & Lerch 2015 [6, 7]). On the kit under
a plucked bass and a chord pad, the result is:

| voice | drums-only mode | full-mix mode |
| --- | --- | --- |
| hats | 64/64 | 64/64 |
| kick | 23/24, 34 false | 23/24, ~100 false (bass plucks) |
| snare | 3/32 | 13/32 |

So full-mix mode is marked experimental. The way past it is source separation before this pipeline:
a Demucs-class model [8] run in the browser (ONNX Runtime Web) to pull out the drum stem, then everything
above unchanged. The model would supply the labels and the sample-level timing would still come from
here, because a separation model's frames are coarser than a pocket.

## What Basic Pitch teaches

[Basic Pitch](https://engineering.atspotify.com/2022/6/meet-basic-pitch) [9, 10] is Spotify's
audio-to-MIDI model for pitched instruments. It transcribes notes, not drums, so it can't replace the
detector here. But several of its choices bear on the full-mix path, and one points to a new feature:

- **A small model is enough, and it runs in the browser.** Basic Pitch has fewer than 17,000
  parameters and peaks under 20 MB of memory [9]. Its TypeScript port runs on TensorFlow.js
  ([`@spotify/basic-pitch`](https://github.com/spotify/basic-pitch-ts), Apache 2.0) [11]. A drum
  onset model of the same size could run in this app's analysis worker. The size and cost of a
  separation model like Demucs [8] is what needs checking before that step.
- **Predicting onsets alongside activations helps both.** It predicts onsets, note activations and
  pitch bends as separate outputs. The paper reports that learning them together improves the
  frame-level accuracy [10]. Here the onsets come from the rise of each voice's activation. A
  learned drum model should keep a separate onset output, as drum transcription models do [12].
- **Its frames are too coarse for a pocket.** It works at 22,050 Hz with a 256-sample hop, 86
  frames a second, so a frame is 11.6 ms [13], the size of the leans this step measures. That
  supports the split planned above: a model labels the hits, and the sample-level timing
  (`dsp/refine.ts` on band-filtered audio) places them. A model's frame alone could only place a
  hit to within about ±6 ms.
- **One instrument at a time works best.** Its documentation says it works best on one instrument
  at a time [13]. That matches what the full-mix test above shows: separate first, then transcribe.
- **The bass is part of the pocket.** Pocket Science has a bass voice, and a drummer's pocket is
  often heard against the bass. Basic Pitch on a separated bass stem would give bass notes with
  onsets. After the same sample-level timing, the bass could be measured against the kick in this
  chart. It is the most direct use of Basic Pitch here.

## Test material with ground truth

The synthetic kit proves the pipeline but not how it handles real kits, rooms and players. Real
recordings with known hit times would:

- **IDMT-SMT-Drums** [3]: kick, snare and hi-hat recordings with onset annotations, the three voices
  detected here. The first real-audio benchmark to run.
- **E-GMD** [12]: 444 hours of audio, the Groove MIDI Dataset's performances re-recorded on 43 kits
  through a Roland TD-17, with MIDI and velocities. The audio is aligned to the MIDI within 2 ms
  [12], so it can check detection and the velocity mapping well, but timing only to about 2 ms.
- **Groove MIDI Dataset** [14]: the professional performances E-GMD is built from. Its paper
  models expressive micro-timing ("humanization"), the same quantity as this step's offsets.
- **ADTOF** [15]: 359 hours of real music with drum annotations from rhythm games, for full mixes.
  The annotations are cleaned, but not to sub-millisecond accuracy, so ADTOF can test detection but
  not timing.
- **Multitrack sessions**: a take with close mics on kick and snare gives each voice's true onset
  from its own mic, and the mix of the overheads is the test input. The best check on a real room.

## References

1. C.-W. Wu, C. Dittmar, C. Southall, R. Vogl, G. Widmer, J. Hockman, M. Müller, A. Lerch. "A
   Review of Automatic Drum Transcription." IEEE/ACM TASLP 26(9), 2018, pp. 1457–1483.
   <https://dl.acm.org/doi/10.1109/TASLP.2018.2830113> · resources:
   <https://www.audiolabs-erlangen.de/resources/MIR/2017-DrumTranscription-Survey>
2. Pocket Science, the groove atlas this step's chart and export follow:
   <https://github.com/jacobanana/pocket-science>
3. C. Dittmar, D. Gärtner. "Real-time transcription and separation of drum recordings based on NMF
   decomposition." DAFx-14, 2014, pp. 187–194. <https://publica.fraunhofer.de/handle/publica/387292> ·
   IDMT-SMT-Drums dataset: <https://www.idmt.fraunhofer.de/en/publications/datasets/drums.html>
4. C. Févotte, J. Idier. "Algorithms for nonnegative matrix factorization with the β-divergence."
   Neural Computation 23(9), 2011, pp. 2421–2456. <https://hal.sorbonne-universite.fr/ENST/hal-00626110v1>
5. D. FitzGerald. "Harmonic/percussive separation using median filtering." DAFx-10, Graz, 2010.
   <https://arrow.tudublin.ie/argcon/67/>
6. C.-W. Wu, A. Lerch. "Drum transcription using partially fixed non-negative matrix factorization."
   EUSIPCO 2015. <https://ieeexplore.ieee.org/document/7362590/>
7. C.-W. Wu, A. Lerch. "Drum transcription using partially fixed non-negative matrix factorization
   with template adaptation." ISMIR 2015. <https://zenodo.org/records/1417839> · toolbox:
   <https://github.com/cwu307/NmfDrumToolbox>
8. S. Rouard, F. Massa, A. Défossez. "Hybrid Transformers for Music Source Separation." ICASSP 2023.
   Code (Demucs v4): <https://github.com/adefossez/demucs>
9. Spotify Engineering. "Meet Basic Pitch: Spotify's open source audio-to-MIDI converter." 2022.
   <https://engineering.atspotify.com/2022/6/meet-basic-pitch>
10. R. M. Bittner, J. J. Bosch, D. Rubinstein, G. Meseguer-Brocal, S. Ewert. "A Lightweight
    Instrument-Agnostic Model for Polyphonic Note Transcription and Multipitch Estimation." ICASSP
    2022. <https://arxiv.org/abs/2203.09893>
11. Basic Pitch for TypeScript (TensorFlow.js): <https://github.com/spotify/basic-pitch-ts>
12. L. Callender, C. Hawthorne, J. Engel. "Improving Perceptual Quality of Drum Transcription with the
    Expanded Groove MIDI Dataset." 2020. <https://arxiv.org/abs/2004.00188> · dataset:
    <https://magenta.tensorflow.org/datasets/e-gmd>
13. Basic Pitch (Python), README and `basic_pitch/constants.py` (22,050 Hz, `FFT_HOP = 256`):
    <https://github.com/spotify/basic-pitch>
14. J. Gillick, A. Roberts, J. Engel, D. Eck, D. Bamman. "Learning to Groove with Inverse Sequence
    Transformations." ICML 2019. <https://arxiv.org/abs/1905.06118>
15. M. Zehren, M. Alunno, P. Bientinesi. "ADTOF: A large dataset of non-synthetic music for automatic
    drum transcription." ISMIR 2021. <https://arxiv.org/abs/2111.11737>
