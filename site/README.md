# stator site (Astro)

Static landing for [listepo/stator](https://github.com/listepo/stator). Built with Astro (`output: 'static'`). Deployed to GitHub Pages at `/stator/`.

## Layout

| Path | Purpose |
|------|---------|
| `src/pages/` | Routes (`index.astro` = landing) |
| `src/layouts/` | Shared HTML shell |
| `src/components/` | Reusable UI pieces |
| `src/styles/` | Global CSS + brand tokens (`tokens.css`) |
| `src/scripts/` | Build-time sources shared with the config (the theme boot script) |
| `scripts/` | `check.ts`, the browser check |
| `public/` | Static assets (logos, favicon, `js/theme.js`) served as-is |
| `dist/` | Build output (gitignored) |

Brand source of truth: `../docs/brand/` (`DESIGN.md`, `tokens.css`, SVGs). When brand tokens change, sync `src/styles/tokens.css` and re-copy logos into `public/`.

Landing screenshots for review: `../docs/assets/landing-v1/` (owned by design).

## Commands

Requires Node ≥ 22 (Node 24 via mise is fine) and pnpm; `check:browser` needs Node ≥ 24 (type stripping) and Chrome.

```bash
cd site
pnpm install
pnpm dev      # http://localhost:4321/stator/
pnpm build    # writes dist/
pnpm preview  # serve dist/ with the same base path
pnpm run check:browser  # after a build: drive Chrome over dist/ (below)
```

`check:browser` (`scripts/check.ts`, strict TypeScript run by Node's type stripping) serves
`dist/` under the base path and drives the installed Chrome through `playwright-core`
(`CHROME_PATH` overrides the stable channel; no browser is downloaded). It fails when the page
requests another origin, violates its CSP, scrolls sideways at 320 or 360 px, when the theme
toggle stops cycling `light → dark → system` with `localStorage` blocked, or when the toggle
shows without JS. The site workflow runs it after every build.

## Fonts and CSP

IBM Plex Sans and Mono (OFL-1.1) are self-hosted from `@fontsource/ibm-plex-*`: the build copies
the woff2 files into `dist/`, so a visit requests nothing from a third party. Every page carries a
`<meta http-equiv="content-security-policy">` from `security.csp` in `astro.config.ts`
(`default-src 'self'`). Astro hashes the scripts and styles it bundles; the inline theme boot
script is not one of them, so its source lives in `src/scripts/theme-boot.ts` and the config adds
its hash. Edit the boot script there, never inline. Astro puts the CSP meta at the end of
`<head>`, which only governs what comes after it, so the layout's scripts open `<body>`.

## Base path (GitHub Pages)

`astro.config.ts` sets `base: '/stator/'` for project Pages (`https://listepo.github.io/stator/`).

Local preview **without** the `/stator/` prefix:

```bash
ASTRO_BASE=/ pnpm build
ASTRO_BASE=/ pnpm preview
```

CI always builds with the default `/stator/` base.

## Deploy

`.github/workflows/pages.yml` builds this package on `main` (and checks PRs that touch `site/**`).
It publishes `site/dist` only when GitHub Pages is enabled for the repository (Settings → Pages →
Source: GitHub Actions). If Pages is not enabled, the workflow still builds and browser-checks the
site, and skips the upload and the deploy.
