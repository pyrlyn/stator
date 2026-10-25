// @ts-check
import { createHash } from 'node:crypto';
import { defineConfig } from 'astro/config';
import { THEME_BOOT } from './src/scripts/theme-boot.ts';

// GitHub project Pages: https://listepo.github.io/stator/
// Local root preview: ASTRO_BASE=/ pnpm build && ASTRO_BASE=/ pnpm preview
const base = process.env['ASTRO_BASE'] ?? '/stator/';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  base,
  site: 'https://listepo.github.io',
  // A <meta> CSP on every page: Astro hashes its own scripts and styles into script-src and
  // style-src, the boot script's hash is added here, and everything else, fonts included, must
  // come from this origin.
  security: {
    csp: {
      scriptDirective: {
        hashes: [`sha256-${createHash('sha256').update(THEME_BOOT).digest('base64')}`],
      },
      directives: [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'none'",
      ],
    },
  },
});
