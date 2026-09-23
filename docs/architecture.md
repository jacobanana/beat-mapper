# Architecture

BeatMapper is layered. Each layer only uses the ones below it, and the bottom two have no DOM, no
Web Audio and no app state in them, so they can be tested in Node, run in a worker, or lifted into
another app (a DAW plugin, a CLI, a server) as they are. ESLint enforces the boundary.

```
ui/        DOM panels, canvas rendering, pointer and keyboard input
  │ calls features, listens to App topics
app/       App (state + derived data + undo) and features (markers, beats, playback, slicer…)
  │
state/     the undoable ProjectDoc, settings, History, Viewport, Emitter, memo
engine/    Web Audio: Player (transport + metronome + drum hits), synth kit, grains, one-shot previews
analysis/  Analyzer interface; runs core/dsp and core/warp in a Web Worker
  │
io/        file formats (MIDI, REAPER, WAV, ZIP), the session format, downloads
core/      the audio-editing logic: DSP, markers, tempo map, beat tracking, slicing
```

## core/ – the audio logic

Pure functions and immutable values. Times are seconds; musical positions `q` are quarter notes
from bar 1.

| Module | What it does |
| --- | --- |
| `dsp/onset.ts` | One FFT pass → four onset detection functions (spectral flux, complex domain, group delay, energy) in three bands. |
| `dsp/refine.ts` | Places a coarse onset on the real attack at sample level, then on a zero crossing. |
| `dsp/tempo.ts` | Starting tempo by autocorrelation. |
| `dsp/peaks.ts` | Mono mixdown and the min/max pyramid the waveform is drawn from. |
| `markers/detect.ts` | Candidates from a detection function; which ones the sensitivity and gap let through; merging in manual markers and deletions. |
| `tempo/meter.ts` | Meter and grid: bar/beat lengths, grid levels, nearest grid line. |
| `tempo/tempo-map.ts` | `TempoMap`: pins → time↔position, BPM at a time, bars. |
| `beats/track.ts` | Beat tracking outward from a known point, and auto-mapping between pins. |
| `beats/edit.ts` | Every edit to the pins as a pure function: set bar 1, pin, unpin, drag, auto-map, derive from a loop, half/double time, tap tempo. |
| `slices/` | Slice planning, rendering (fades, mono, normalize), loop info, file naming. |
| `dsp/filter.ts` | Zero-phase biquads (forwards then backwards), for timing a voice's attack in its own band. |
| `drums/` | Kick, snare and hats: a log-frequency spectrogram (optionally percussive-only), NMF with semi-adaptive templates, per-voice hit picking and bleed cancelling, sensitivity. See [groove.md](groove.md). |
| `warp/` | Warping onto a straight grid: the warp map from the tempo map (`map.ts`), and one algorithm per kind of material (drum slicing, WSOLA, phase-locked phase vocoder, harmonic-percussive split, re-pitch). See [warp.md](warp.md). |
| `groove/pocket.ts` | Every drum hit on its grid step, measured against a reference voice bar by bar; per-voice and per-step statistics, swing. `transcribe` turns the hits into notes for the synth kit and the MIDI transcript. |

## io/

`formats/` writes MIDI (type 1, tempo track + click, and a drum track when given notes), REAPER
`.rpp`, PCM WAV and stored ZIP, all byte-for-byte what the single-file app wrote, plus the Pocket
Science groove file (`groove.ts`). `session.ts` reads and writes the session JSON,
validating and clamping everything it reads. `download.ts` saves a file (through a host's download
bridge when the app runs inside one).

## state/ and app/ – what the user is editing

- **`ProjectDoc`** (`state/project.ts`) is everything undo covers: meter, pins and base tempo,
  manual markers and deleted candidates. It is immutable; each edit returns a new document.
- **`History`** keeps previous documents. Recording is a reference push, so a new field in the
  document is undoable with no extra code. A drag checkpoints once at its start and then edits
  without recording, so the whole drag is one undo step.
- **Settings** (`state/settings.ts`) are what the controls are set to: saved with the session, not
  undone.
- **`App`** (`app/app.ts`) holds the document, settings, the audio and its analysis, and derives
  everything else on demand, memoised on the identity of its inputs: the visible markers, the tempo
  map, the grid, the bars, the slices, the drum hits the sensitivities let through, the notes they make, and the pocket. Nothing derived is stored, so nothing can go stale.
- **Features** (`app/features/`) are the verbs: `Markers`, `Beats`, `Playback`, `Slicer`,
  `Exports`, `Warp`, `Groove`, `Mixer`, `Sessions`, `Loader`, `Workflow`. They change the App and emit topics (`'doc'`,
  `'transport'`, `'slices'`…). They talk to the user only through the `Notifier` interface.

## ui/

- `canvas/editor-renderer.ts` redraws the editor and overview when a topic fires, at most once a
  frame, from `canvas/layers.ts`: one function per layer, reading state and drawing nothing else.
- `input/pointer.ts` maps where a touch lands (`canvas/layout.ts` zones) to features: loop strip,
  bar ruler, edit half, move half, time ruler. `input/keyboard.ts` is the shortcut table.
- `panels/` bind each step's controls to features and re-render their text on the topics they show.
  `export-dialog.ts` is the Export window: every format, each showing only the options that change
  it; `mixer-panel.ts` is the mixer popover. Step 3 was Export; it is kept as a `Step` value so old
  sessions load, and `Workflow` sends it to Beats.
- Where a new button goes (top bar groups, panel clusters, dialogs) is set out in
  [ui-conventions.md](ui-conventions.md).

## Tests

- `test/parity.test.ts` runs the original single-file core (`test/legacy/`, kept verbatim) side by
  side with this one on the demo loop and requires identical output: detection functions, markers,
  beat tracking, every pin edit, derive-from-loop, and the MIDI/REAPER/WAV/ZIP bytes. When a change
  to the core is meant to alter behaviour, retire the case it breaks and pin the new behaviour in a
  unit test instead.
- `test/app.test.ts` drives the App and features without a browser.
- `test/session.test.ts` checks old session files load and save back unchanged.
- `test/groove.test.ts` runs the drum detector and the pocket analysis on a synthetic kit whose
  pocket is known (`synthKit` in `core/demo.ts`), and pins what full-mix mode can and can't do.
- `e2e/smoke.mjs` walks the built app through every step in Chromium.

## Adding things

- **A new analysis or edit**: write it in `core/` as a pure function with a test, then expose it
  through a feature.
- **A new thing the user edits**: add it to `ProjectDoc` if it should undo, to settings if not, and
  to `SessionContent` + `toSessionJson`/`parseSession` if it should persist (bump
  `SESSION_VERSION` and keep reading version 1).
- **A new export format**: a pure writer in `io/formats/`, called from `Exports`.
- **A new view**: a layer function in `ui/canvas/layers.ts`, or a panel in `ui/panels/`.
