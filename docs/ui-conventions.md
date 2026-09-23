# Where buttons go

BeatMapper sits between an audio editor and a DAW, so its controls follow the conventions of both
(Logic, Ableton Live, REAPER, Audacity) and of editors in general (Google Docs, Figma). This page
records those rules, the audit that applied them, and what was left as it is. Follow them when
adding a control.

## The rules

**Top bar, left to right** (desktop, one row):

| Group | Buttons | Why there |
| --- | --- | --- |
| File | Open, Session, Export, file name | File actions come first in every editor and DAW. Session (save the work, or open a saved one) sits by Open since it is opened like a file and wanted from every step. |
| Edit | Undo, Redo | Undo and redo are a pair next to the file actions, and grey out when there is nothing to undo or redo. |
| Steps | Transients, Beats, Warp, Slice, Groove | Main navigation, as tabs; icon only, with a text label from 1520 px wide. |
| Transport (middle) | Go to start ⏮, Play/Stop ▶ · Loop, Scrub, Stay-on-stop · Click, Mixer | DAWs put "go to start" left of play, then loop. The click sits by the mixer, since both are about what you hear. Toggles show their state with `aria-pressed`. |
| Readout | time · bar.beat · BPM | Next to the transport, as a DAW's position display is. |
| View (right) | Zoom out, Zoom in, Fit | Zoom out and zoom in sit together, with fit after them. Zoom out/in are hidden on touch, where you pinch instead. |
| Help | ? | Help goes at the far right. |

**On a phone** the same groups stack into three rows, and a group never splits across rows: file,
edit and steps; then the transport, mixer and fit; then the readout, with help at its far end. Help
moved down when Session joined the file group: ten 38 px buttons don't fit one row at 375 px. This was checked at
375 px (the smallest iPhone in common use) and 411 px.

**Panels:**

- A panel bar is made of clusters (`<span class="cluster">`). A cluster wraps as a whole, and
  clusters are told apart by space rather than by separator lines, so a group never splits across a
  line.
- Order within a bar: what is being measured, then navigation (previous and next), then edits (add,
  delete, pin), then anything destructive (reset, clear) last and on its own.
- A panel with more than a few controls is laid out in the order the work goes, one captioned row per
  stage (Beats: **Tempo**, then **Map**, then **Fix**), with what changes how a stage behaves folded
  under **Options** below them. Buttons in these rows carry a text label, since the caption and the
  label together say what a button does and what it changes.
- Every step has a **Reset** with a text label, last in its bar: it starts that step again, as it was
  on arriving, and greys out while there is nothing to reset. What it discards from the document comes
  back with undo; the settings it puts back do not.
- Tempo comes before the time signature (`92 BPM · 4/4`), as in every DAW's control bar. The grid
  sits next to the magnet (snap), since the two go together.
- A count says what it counts: `128 markers`, `1 pin`, `128/128 kept`.
- The main action of a panel is the one filled button (`.btn.primary`), and it has a text label,
  not only an icon: **Derive**, **Auto-map**. At most one primary per panel.

**Dialogs and popovers:**

- A dialog has its title at the top left, a close button at the top right, and Cancel then the
  default action at the bottom right. Escape and a click on the backdrop close it.
- Every file a step makes goes out through the one Export window, never through a button in a panel.
  The window lists only what the current step makes (Beats: tempo map; Warp: warped audio; Slice:
  samples; Groove: drums), and the Export button is off in Transients, which makes nothing of its
  own. The session is the exception: it is the work itself, so it has its own popover by Open.
- On a phone the Export window's formats are a dropdown: a button showing the chosen format and a
  line on what it holds, opening the grouped list with that line under every format. Escape or a
  press outside closes the list before the window.
- A popover (the mixer) opens under the button that opened it, and closes on Escape or on a press
  anywhere else.

**Everywhere:**

- Every icon-only button has a `title` with its shortcut in brackets, and an `aria-label`.
- Buttons are at least 38 px square on touch screens.
- One colour means on: teal. The loop, scrub and stay toggles are blue instead, because the loop
  and the start flag are blue on the waveform.

## The audit (this pull request)

| Found | Changed to |
| --- | --- |
| Play came before "go to start" | ⏮ then ▶, as in DAWs |
| The modes were in no set order (stay, loop, scrub, click) | Loop, scrub, stay, then the click next to the mixer |
| Undo sat among the zoom buttons, and there was no redo button | Undo and redo after the file actions, greyed out when unavailable |
| The zoom order was out, fit, in | Out, in, fit |
| Export sat between the steps and the tools | With Open, among the file actions |
| The mixer popover was pinned to the right edge | It opens under its button |
| The Beats bar went time signature, grid, tempo | Tempo, time signature; grid next to the magnet |
| Groups split across lines when a bar wrapped (pin, unpin and clear on different lines) | Clusters that wrap as wholes |
| Previous/next and add/delete/reset were one group in Transients | Navigation, edits and reset are separate groups, with reset last |
| The primary buttons were icon-only (derive) | Derive and Auto-map have text labels |
| Bare counts (`88`, `1`, `88/88`) | `88 markers`, `1 pin`, `88/88 kept` |
| The slice panel's "all" button | "Keep all" |
| The Export window had no Cancel | Cancel next to Save |
| Tabs were icon-only even on a wide screen | Text labels from 1520 px wide |

## Left as it is, and why

- **Touch targets are 38 px, not the 44 px Apple asks for (48 dp for Material).** At 44 px the top
  bar needs a fourth row on a phone, and the waveform is what needs the height. 38 px is past the
  WCAG 2.2 minimum of 24 px.
- **Play and stop are one button.** Web audio players and phone apps do it this way. Space toggles
  it as in every DAW.
- **"Go to start" also plays.** In BeatMapper you almost always go back to listen, so ⏮ plays from
  the first transient, or from the loop start. Enter does the same.
- **The mixer button sits in the transport, not beside a master fader.** There is no room for a
  fader on a phone, so a popover holds the levels.
