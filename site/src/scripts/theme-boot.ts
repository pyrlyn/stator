/** The theme boot script, inlined at the top of <body> so the stored theme applies before first
 * paint. One string feeds both the page (BaseLayout.astro) and the CSP hash (astro.config.ts):
 * Astro hashes only the scripts it processes, not an `is:inline` one, so the policy would
 * otherwise block this script or drift from it on the next edit. */
export const THEME_BOOT = `(function () {
  var pref = 'system';
  try {
    pref = localStorage.getItem('stator-theme') || 'system';
  } catch (e) {
    /* private mode / blocked storage: the system theme still resolves below */
  }
  if (pref !== 'light' && pref !== 'dark' && pref !== 'system') pref = 'system';
  var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  var resolved = pref === 'system' ? (dark ? 'dark' : 'light') : pref;
  document.documentElement.setAttribute('data-theme', pref);
  document.documentElement.setAttribute('data-theme-resolved', resolved);
  document.documentElement.style.colorScheme = resolved;
})();`;
