# One entry point per verb — the same words a human types, an agent types and
# CI runs. Nothing in the Claude loop depends on this file: the hooks call
# scripts/*.sh by path, because a hook cannot rely on make being installed.
# Every target is one line that shells out; the script stays the truth.
.DEFAULT_GOAL := help

.PHONY: help install ready dev preview stop shots checks build e2e pre-pr eval-notes clean

help:
	@echo ""
	@echo "  beat-mapper"
	@echo ""
	@echo "    make ready      wait for the dev environment to be prepared"
	@echo "    make dev        start the dev server (detached, idempotent)"
	@echo "    make preview    build, then serve the production build"
	@echo "    make stop       stop what dev/preview started"
	@echo "    make shots      photograph the app at phone and desktop widths"
	@echo ""
	@echo "    make checks     the commit gate: typecheck + lint + unit tests (silence = pass)"
	@echo "    make build      typecheck + production build"
	@echo "    make e2e        the Playwright smoke test against dist/"
	@echo "    make pre-pr     checks, build, e2e — run before opening a pull request"
	@echo "    make eval-notes score the note detector on BabySlakh (scripts/fetch_slakh.sh first)"
	@echo ""
	@echo "    make clean      remove node_modules, dist and .dev"
	@echo ""

install:
	npm ci

ready:
	bash scripts/await_ready.sh

dev:
	bash scripts/start_app.sh

preview:
	bash scripts/start_app.sh --build

stop:
	bash scripts/stop_app.sh

shots:
	node .claude/skills/app-screenshots/scripts/screenshot.mjs --width phone --width desktop

checks:
	bash scripts/checks.sh

build:
	npm run build

# A Claude container ships its Chromium at /opt/pw-browsers/chromium, a build
# older than the one this repo's Playwright asks for — without the override
# e2e fails with "please run npx playwright install", which is a download the
# container cannot make. Elsewhere Playwright's own browser is used.
e2e:
	CHROMIUM_PATH=$${CHROMIUM_PATH:-$$(test -x /opt/pw-browsers/chromium && echo /opt/pw-browsers/chromium)} npm run e2e

pre-pr: checks build e2e

eval-notes:
	npx vitest run --config bench/vitest.config.ts

clean:
	rm -rf node_modules dist .dev
