# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**CuriousScout** — a static site (no build system) hosting a collection of browser games. The root `index.html` is an arcade/neon-themed landing page (byline "By Lunga Khumalo", Buy Me a Coffee support at buymeacoffee.com/curiousscout) that links to each game.

There is **no package.json, bundler, test runner, linter, or CI**. Everything is hand-written HTML/CSS/JS opened directly in a browser.

## Layout

- `index.html` — the landing page. Contains a `<main>` of game cards.
- `<game name>/index.html` — each game is **one fully self-contained file** (all CSS and JS inline) in its own directory: `astronomia/`, `balloon pop/`, `claudecraft/`, `cluckdown/`, `football rivals/`, `geo-jump/`, `math mine/`. Directory names may contain spaces.

The only external runtime dependencies in the entire repo are CDN `<script>`/`<link>` tags: the landing page loads Google Fonts (Orbitron, Press Start 2P), and `claudecraft/` plus `astronomia/` load three.js from cdnjs. Note the cdnjs path uses `r128`, **not** `0.128.0` — the latter 404s. Games are otherwise dependency-free — there is no local `node_modules` to install, and any that appears is stray and should not be committed (see `.gitignore`).

## Running / verifying

No install or build. Either open a game file directly:

```bash
open "claudecraft/index.html"      # macOS; opens in default browser
```

…or serve the root to exercise the landing page and its links together:

```bash
python3 -m http.server 8000        # then visit http://localhost:8000
```

## Publishing

Convention: **commit straight to `main` and push — no PRs.** The site deploys automatically via **Cloudflare Workers** whenever changes land on `main` at `origin` (github.com:sithembiso/curiousscout.git), so pushing `main` is the publish step. (GitHub Pages is not used.)

## Adding or updating a game

1. Put the game at `<game name>/index.html`, fully self-contained.
2. Add a card to the top of `<main>` in the root `index.html` (newest games are listed first). Follow the existing card pattern exactly:

```html
<a class="card" href="<dir>/" style="--accent:#HEX;">
  <div class="icon"><svg viewBox="0 0 64 64" ...>…inline SVG icon…</svg></div>
  <h2>Game Name <span class="ver">1.0</span></h2>
  <p>Short blurb.</p>
  <div class="play">PLAY &#9654;</div>
</a>
```

Conventions to preserve:
- **URL-encode spaces** in the `href` (e.g. `football%20rivals/`, `math%20mine/`).
- Each card sets a per-game accent color via the inline `--accent` custom property and carries a hand-drawn inline `<svg>` icon.
- The `<span class="ver">` badge holds the version label — free-form (e.g. `1.0`, `WC`, `0.6`). ClaudeCraft uses a `0.x` lineage (0.1 Aether → 0.2 Underworld → 0.3 Milk & Honey → 0.4 Swords → 0.5 Pets → 0.6 Demons & Angels), which supersedes any older `5.0`-style number.
- Games namespace their DOM ids with a short prefix (`cc-` ClaudeCraft, `mtc-` math mine, `round-` balloon pop). Since each game is its own page this is stylistic scoping, not a hard requirement — but match the game's existing prefix when editing one.
