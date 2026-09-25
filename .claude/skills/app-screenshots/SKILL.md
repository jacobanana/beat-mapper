---
name: app-screenshots
description: Run this Vite app locally and photograph it with Playwright. Use whenever a frontend change has to be shown rather than described, or when asked to start, run or screenshot the app — captures any screen at phone and desktop widths, in either theme.
---

# Screenshot the app

A layout claim nobody can see is not evidence. Every visual change is
photographed at the widths it crosses — before as well as after when the point
of the change is how it looks.

This matters more here than in most repos, because the person reading the
result is on a phone. They cannot run the branch. The screenshot *is* the
review.

## 1. Start the app

```bash
bash scripts/start_app.sh
```

Idempotent — reuses whatever is already answering. Prints the base URL, and
writes it to `.dev/base_url` where the screenshot script looks for it. Logs
land in `.dev/app.log`; stop with `bash scripts/stop_app.sh`.

## 2. Photograph it

```bash
node .claude/skills/app-screenshots/scripts/screenshot.mjs --width phone --width desktop
```

| Option | Meaning |
| --- | --- |
| `--width phone\|tablet\|desktop\|<px>` | Repeatable. phone=390, tablet=768, desktop=1440. |
| `--path <path>` | Page or `#fragment` to open. Default `/`. |
| `--click <selector>` | Repeatable, applied in order — open a menu, expand a section. |
| `--select <selector>=<value>` | Choose in a `<select>`; repeatable, in order with the clicks. |
| `--pause <ms>` | Wait between steps, in order with them: a demo has to load before the next click. |
| `--theme light\|dark` | Force a colour scheme rather than taking the runner's. |
| `--full-page` | Capture the whole scroll height, not just the viewport. |
| `--wait <ms>` | Settle time before the shot, for an animation. |
| `--name <slug>` | Filename prefix. |
| `--base <url>` | Override `.dev/base_url`. |

PNGs land in `.dev/screenshots/` and every written filename is printed.

## 3. Send them to the chat

**This is the step that is actually the deliverable.** Read the images back
and attach them with `SendUserFile`, in the same turn you take them — do not
save them under `.dev/screenshots/` and write a sentence saying where they
are. A path is not a picture, and the person reading this is on a phone.

Send them as you go, not batched at the end.

## Common shots

The app opens on an empty drop zone, which proves nothing. Load the demo loop
first: analysis runs in a worker, so give it a few seconds.

```bash
# The analysed demo loop at both widths
node .claude/skills/app-screenshots/scripts/screenshot.mjs --width phone --width desktop --click '#demoBtn' --wait 6000 --name demo

# Both themes, to check a colour change
node .claude/skills/app-screenshots/scripts/screenshot.mjs --theme light --theme dark --width desktop --click '#demoBtn' --wait 6000
```

## Troubleshooting

- **Nothing answering** → `bash scripts/start_app.sh` first; check `.dev/app.log`.
- **A blank or half-drawn page** → the script prints console and page errors it
  saw; read those before re-shooting.
- **No browser** → it falls back through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`,
  `/opt/pw-browsers/chromium` and the system chromium before giving up.
- **A collapsed section photographs as a heading** → that is the shot the
  reviewer will disbelieve. `--click` it open first.
- **A band of empty background above a sticky header** is the script, not the
  page: it is what a torn frame looks like when the shot lands mid-scroll. It
  should not happen — the runner forces reduced motion and waits for scrolling
  to stop — but if you ever see one, re-shoot before reporting a layout bug.
