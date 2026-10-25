# stator — Design System

## Overview

**stator** is an AOT TypeScript/JavaScript → native compiler. Metaphor: stator (fixed machine housing) / static / type → bits. Mark combines a stator ring, a type-bracket on the left, and machine-code bit ticks on the right.

Identity: electric indigo-blue + cool gray. Not neon purple; calm engineering blue.


**Shared visual lock (Listepo landing v1):** **nerd + ai + glass + flat** — same family as ketch brand v1. IBM Plex Mono eyebrows/labels/chips, hairline borders, mono CLI cards; subtle agent/compute cues (soft accent glow, gradient hairline, status chips) using **indigo `#5B7CFF` only** (no purple AI gradients); translucent glass panels with `backdrop-filter` plus opaque `@media (prefers-reduced-transparency: reduce)` fallbacks; flat CTAs, 4/8pt spacing, surface ladder, radii 8–12.

## Colors

### Light

| Token | Hex | Use |
|-------|-----|-----|
| bg | `#F5F6F9` | Page background |
| bg-elevated | `#FFFFFF` | Cards |
| surface-1 | `#EBEDF2` | Nested |
| surface-2 | `#DDE1EA` | Hover |
| surface-3 | `#CCD2DE` | Pressed |
| border | `#B4BBC9` | Default border |
| border-hairline | `#D8DCE6` | Divider |
| fg | `#12151C` | Primary text |
| fg-muted | `#4A5160` | Secondary |
| fg-subtle | `#787F90` | Tertiary |
| accent | `#3D5CE5` | Primary CTA |
| accent-hover | `#2E4ACC` | Hover |
| accent-muted | `#5B7CFF` | Soft accent |
| accent-soft | `#E8ECFF` | Accent wash |
| cool | `#8BA3FF` | Secondary highlight |
| code-bg | `#12151C` | Code |
| code-fg | `#A8B8FF` | Syntax accent |

### Dark

| Token | Hex | Use |
|-------|-----|-----|
| bg | `#0C0E14` | Page background |
| bg-elevated | `#12151C` | Cards |
| surface-1 | `#1A1E28` | Nested |
| surface-2 | `#242936` | Hover |
| surface-3 | `#303848` | Pressed |
| border | `#3C4558` | Default border |
| border-hairline | `#1E2430` | Divider |
| fg | `#E8EBF2` | Primary text |
| fg-muted | `#9AA3B5` | Secondary |
| fg-subtle | `#646E82` | Tertiary |
| accent | `#5B7CFF` | Primary CTA |
| accent-hover | `#8BA3FF` | Hover |
| accent-muted | `#3D5CE5` | Soft accent |
| accent-soft | `#1A2040` | Accent wash |
| cool | `#A8B8FF` | Highlight |
| code-bg | `#080A10` | Code |
| code-fg | `#C5D0FF` | Syntax |

## Typography

- **Mono (compiler output, IR, labels):** IBM Plex Mono (fallback JetBrains Mono)
- **Sans (docs body):** IBM Plex Sans
- Scale: 12 / 14 / 16 / 20 / 28 / 40
- Weights: 400 / 500 / 600

## Layout

- Docs-heavy: content max 920px; sidebar 240px
- 8px grid; cool gray surface ladder; hairline borders
- Logo tile: 64×64, 12px radius

## Components

- **Compile CTA:** solid indigo; mono label `compile`
- **IR / AST panels:** code-bg with cool syntax ticks
- **Type badges:** accent-soft, mono 11px (`string → i64`)
- **Status:** indigo for AOT success; muted for skip
- **Nav:** mono section labels; cool gray chrome

## Mini landing wire

1. Hero: stator mark + wordmark + “TS/JS → native. Ahead of time.”
2. Pipeline: type → IR → bits (three mono steps)
3. Code sample: `stator build ./app.ts`
4. Footer: Listepo + docs

## Do / Don't

**Do**
- Indigo-blue for precision; cool gray for machine quiet
- Keep type-bracket + bit ticks legible at favicon size
- Mono for compiler UX

**Don't**
- No neon purple, magenta, or holographic gradients
- Don’t collide with rtok cyan — stay indigo, not sky
- Avoid literal motor illustrations; one geometric metaphor
