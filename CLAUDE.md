# BeatMapper

Vite + TypeScript, no UI framework. Read `docs/architecture.md` before changing structure.

- `npm run check` (typecheck, lint, unit tests) must pass; `npm run build && npm run e2e` for UI changes.
- Layering is enforced by ESLint: `src/core` and `src/io/formats` must not touch the DOM, Web Audio,
  `app/`, `ui/`, `engine/` or `state/`.
- `ProjectDoc` is immutable. Change it only through `app.edit(fn)` (recorded for undo) or
  `app.edit(fn, false)` after an `app.checkpoint()` (drags).
- Derived data (markers, bars, slices, tempo map) is computed by getters on `App`; don't cache it
  elsewhere.
- Where anything sits in time on screen, or which bar/beat/tempo a moment is heard at, comes from
  `app.timeline` (see `docs/architecture.md`, Time on screen); bars and tempo come from the tempo map,
  never the warp's alignment. `test/timeline.test.ts` must keep passing: what is drawn is what is heard.
- `test/legacy/` is the original single-file app's code, kept verbatim for the parity tests. Don't
  edit it.
- Session JSON (`io/session.ts`) and the `beatmapper:*` localStorage keys are shared with saved user
  work: keep reading old versions.
- A new setting the user changes is saved with the session: add it to `SessionContent`,
  `toSessionJson`/`parseSession` (clamped, with its default when missing) and `Sessions.content`/`apply`,
  with a round-trip test. Write it only when it differs from its default, so older sessions still save
  byte-identical and older readers ignore it; that needs no version bump or asking first.
- Comments explain why, in plain sentences, like the existing ones.

## Workflow

Most sessions here are started from a phone and read back as a pull request.

- **Before any check, wait for the environment**: `bash scripts/await_ready.sh`. A web or mobile
  container is cloned fresh with no `node_modules`; the SessionStart hook starts `npm ci` in the
  background and this blocks until it has finished. Don't debug a missing module before it returns.
- **Commit gate**: `bash scripts/checks.sh` (typecheck, lint, Vitest; silence is the pass). The
  `PreToolUse` hook in `.claude/` runs it before every `git commit` that touches code, and CI runs
  the same script.
- **Pre-PR gate**: `make pre-pr` (checks, build, e2e). `make e2e` points Playwright at the
  container's Chromium; plain `npm run e2e` asks for a browser download that a container can't make.
- **Done means seen, not green.** A UI change is shown as screenshots (the `app-screenshots` skill),
  sent to the chat with `SendUserFile`, not saved to a path:
  `bash scripts/start_app.sh` then
  `node .claude/skills/app-screenshots/scripts/screenshot.mjs --width phone --width desktop --click '#demoBtn' --wait 6000`.
  The app is served under `/beat-mapper/`; `start_app.sh` writes that base URL to `.dev/base_url`.
- `.dev/` is the only runtime directory (logs, pids, screenshots) and is gitignored.
- A pull request closes each issue on its own line (`Closes #1`, then `Closes #2`); `Closes #1, #2`
  silently drops the second. An issue only advanced gets `Part of #1`.
- A stated bug, a scoped issue or a change already described: build it and push it. Ask first only
  when the change touches the session JSON format or saved `beatmapper:*` keys, the core/UI layering,
  or a user-facing workflow whose shape is a real choice.
