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
| `beats/edit.ts` | Every edit to the pins as a pure function: set bar 1, pin, unpin, drag, auto-map, derive from a loop, one steady tempo from a loop fitted to the take, half/double time, tap tempo. |
| `slices/` | Slice planning, rendering (fades, mono, normalize), loop info, file naming. |
| `dsp/filter.ts` | Zero-phase biquads (forwards then backwards), for timing a voice's attack in its own band. |
| `drums/` | Kick, snare and hats: a log-frequency spectrogram (optionally percussive-only), NMF with semi-adaptive templates, per-voice hit picking and bleed cancelling, sensitivity. See [groove.md](groove.md). |
| `warp/` | Warping onto a straight grid: the warp map from the tempo map (`map.ts`), warp markers that put single transients on the grid (`markers.ts`), and one algorithm per kind of material (drum slicing, WSOLA, phase-locked phase vocoder, harmonic-percussive split, re-pitch). See [warp.md](warp.md). |
| `timeline.ts` | `Timeline`: where the audio and the grid are drawn on the editor, and what the pointer lands on, following what is heard. See [Time on screen](#time-on-screen). |
| `groove/pocket.ts` | Every drum hit on its grid step, measured against the grid (or, in the core only, a reference voice bar by bar); per-voice and per-step statistics, swing. `transcribe` turns the hits into notes for the synth kit and the MIDI transcript. |

## Time on screen

Times are seconds of two kinds, easy to mix up because both are numbers: **source** time, a moment of
the audio file (the playhead, transients, the loop, warp markers), and **axis** time, a point along the
editor that the viewport turns into pixels. Musical **positions** (quarter notes) are the third kind.

- The **tempo map** is the music: bars, beats and tempo are only read from it. The axis is its time,
  so the grid is drawn where it puts it.
- The **alignment** (`core/warp/markers.ts`) is where the warp puts the audio: the pins with the warp
  markers laid over. It has positions only, no tempo, so a tempo can't be read from it by mistake.
- **`App.heard`** is the warp heard, or null for the original. While something plays it is what
  plays, which Playback tells the App (`App.playing`): the original while a take is still being
  rendered, and the take made before an edit until the next one plays. Stopped, it is what would play:
  the warp in Warp, Slice and Groove with the Warped switch on, else the original.
- **`App.timeline`** decides where the audio is drawn on the axis, from what is heard: the warp draws
  it moved onto the grid, the original where it is. The canvas layers get `xOf` (audio) and `xAtPos`
  (grid) from it through `ui/canvas/screen.ts`, which the pointer uses too; the readout, grid
  snapping, looping a bar and following the playhead go through it as well.
- **`WarpOut`** (`app/warp-out.ts`) is one warp described once: the part warped, where a moment of
  the original lands in it and back, its straight grid, and the tempo map a DAW gets. The audio, the
  metronome, the synth kit, the timeline, the slices, the pocket and the exports all read it.

So what is drawn under the playhead is what is heard, and a click falls on a grid line drawn, even
while a warp is being rendered.

## The flow

Each step works on what the one before it made:

```
audio ─▶ Transients ─▶ Beats ─▶ Warp ─┬─▶ Slice   samples cut from the warped audio
         markers       tempo    warp   └─▶ Groove  hits measured and written where the warp puts them
                       map      markers
```

Transients and Beats always work on the original: the warp is made from their markers and pins, and
hearing it there would feed the warp back into itself. From Warp on, the **Warped** switch in the top
bar (`WarpSettings.listen`, <kbd>W</kbd>) decides what Warp, Slice and Groove hear, cut, measure and
export. On, `App.warpOut` is the warp as they use it: the plan, the warped file's own steady tempo map,
and `at(t)`, where a moment of the original lands in it. Markers, slices and drum hits keep their
times in the original, so dropped slices, hit edits and the session stay as they are; `at` places them.

- **Slice** cuts only what the warp makes (`App.slices`), from the warp's render (`Warp.render()`,
  shared with playback and the warped .wav), each slice at `at(t0)`–`at(t1)`. Its REAPER project and
  .csv use the warped file's times, at the grid's one tempo.
- **Groove** finds the drums in the original, then measures each hit where the warp puts it, on its
  straight grid (`analyseGroove`'s `at`). The Warp step's Quantize is the only quantize: quantized
  there, a hit lined up by a warp marker sits on its step. The synth kit plays the hits where the warp
  puts them, and the drum MIDI is written at the grid's tempo, lined up with the warped .wav.
`test/timeline.test.ts` checks exactly that for every way of hearing the Warp step, against what the
audio engine plays; ESLint keeps the viewport's `xOf`/`tOf` to the renderer and the pointer, the
alignment to where the warp is made, and the tempo map's time lookups in `app/` and `ui/` to the
timeline.

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
  map, the grid, the bars, the slices, the drum hits the sensitivities let through, the notes they make, the pocket, the warp plan, the
  warp as Slice and Groove use it (`warpOut`), the warp heard (`heard`), and the timeline everything is drawn on. Nothing derived is stored, so nothing can go stale.
  `App.load` starts a new file from the defaults of everything that belongs to a file (the document,
  the selection, the loop, the Warp settings, the shuffle); the mixer and other preferences stay.
- **Steps** (`state/steps.ts` names them, `app/steps.ts` sets their rules): which steps hear the warp,
  what the metronome clicks on, where the synth kit plays, which have an edit half. Anything that
  differs by step reads the table rather than comparing step numbers.
- **Features** (`app/features/`) are the verbs: `Markers`, `Beats`, `Playback`, `Slicer`,
  `Exports`, `Warp` (what is warped and how), `WarpRender` (rendering it, and making what plays follow
  what is wanted), `Groove`, `Mixer`, `Sessions`, `Loader`, `Workflow`. They change the App and emit topics (`'doc'`,
  `'transport'`, `'slices'`…). They talk to the user only through the `Notifier` interface.
- **`'heard'`** is a topic the App emits itself whenever what is heard changes (the warp or the
  original, and which warp), after whatever caused it. A view of anything the warp places (slices,
  the pocket, the readout) listens to it rather than to every topic that could change the warp.

## ui/

- `canvas/editor-renderer.ts` redraws the editor and overview when a topic fires, at most once a
  frame, from `canvas/layers.ts`: one function per layer, reading state and drawing nothing else.
- `input/pointer.ts` maps where a touch lands (`canvas/layout.ts` zones) to features: loop strip,
  bar ruler, edit half, move half, time ruler. `input/keyboard.ts` is the shortcut table.
- `panels/` bind each step's controls to features and re-render their text on the topics they show.
  `export-dialog.ts` is the Export window: what the current step makes, each format showing only the
  options that change it; `session-panel.ts` saves and opens sessions from beside Open;
  `mixer-panel.ts` is the mixer popover. Step 3 was Export and is Warp now (`warp-panel.ts`), so
  a session saved in the old Export step opens in Warp.
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
