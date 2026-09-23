# Groove: measuring the pocket

The Groove step answers the question Pocket Science answers by ear: does the drummer play ahead of
the beat or behind it, and which drum? Here it is measured. Three stages, each in `src/core`:

```
audio ─▶ drums/detect.ts ─▶ hits per voice ─▶ drums/select.ts ─▶ groove/pocket.ts ─▶ pocket
          spectrogram, NMF,     (t, strength,      sensitivity,       grid step, offset
          pick, time, unbleed    loudness)          one per 30 ms     vs reference, stats
```

## 1. Finding kick, snare and hats (`core/drums/`)

A single stream of onsets can't show a pocket. The pocket is a relationship between voices, and on
the backbeat the snare and hat land within milliseconds of each other and would merge into one
marker. So each voice gets its own stream.

- **Spectrogram** (`spectrogram.ts`): 23 ms windows every 5.8 ms, summed into quarter-octave bands.
- **NMF** (`nmf.ts`): the spectrogram is factorised into one spectral template and one activation
  per voice. When hits coincide their spectra add up, and each keeps its own activation. The
  templates start from priors and adapt to the kit (semi-adaptive, Dittmar & Gärtner 2014). Two
  choices matter more than any others; both were found by measuring the bleed between voices:
  - Each template is limited to its own frequency range (kick below 300 Hz, snare above 400 Hz,
    hats above 3 kHz). A snare template allowed down to 150 Hz learns the top of every kick's
    pitch sweep and fires on every kick.
  - The cost is squared error, not KL. KL charges almost nothing for predicting energy in a
    quiet band, which lets one voice explain another's attack.
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
  it was played. It's exact when the export writes a tempo change at every pin.
- **Groove file** (`io/formats/groove.ts`): the typical bar as a Pocket Science `groove-atlas-v2`
  pattern. It holds the steps played in at least half the bars, with offsets in ticks at 480 PPQ.
  `swing_16th` is null because the swing is already in the offsets.

## Full mixes: where this goes next

With **full mix** selected, the spectrogram keeps only its percussive part: a median-filter
harmonic/percussive split, FitzGerald 2010, run in streaming form so memory stays flat. Eight free
NMF components absorb whatever is left of the other instruments (Wu & Lerch 2015). On the kit under
a plucked bass and a chord pad, the result is:

| voice | drums-only mode | full-mix mode |
| --- | --- | --- |
| hats | 64/64 | 64/64 |
| kick | 23/24, 34 false | 23/24, ~100 false (bass plucks) |
| snare | 3/32 | 13/32 |

So full-mix mode is marked experimental. The way past it is source separation before this pipeline:
a Demucs-class model run in the browser (ONNX Runtime Web) to pull out the drum stem, then everything
above unchanged. The model would supply the labels and the sample-level timing would still come from
here, because a separation model's frames are coarser than a pocket.
