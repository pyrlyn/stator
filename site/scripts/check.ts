/* Browser check of the built landing page (plan.md §9 Task 6.26): no request leaves the origin,
 * no CSP violation, no horizontal scroll at 320/360 px, the theme toggle cycles with storage
 * blocked, and it stays hidden without JS.
 *
 * Usage: `pnpm build && pnpm run check:browser`. Chrome comes from CHROME_PATH, else the
 * installed stable channel; playwright-core downloads no browser of its own. */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContextOptions, Page } from 'playwright-core';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
// Must match the base the build used (astro.config.ts).
const BASE = process.env['ASTRO_BASE'] ?? '/stator/';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** dist/ under BASE, the way GitHub Pages serves it. */
function serve(): Promise<{ origin: string; close: () => void }> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    if (!path.startsWith(BASE)) {
      response.writeHead(404).end();
      return;
    }
    let file = normalize(join(DIST, path.slice(BASE.length)));
    if (!file.startsWith(DIST.endsWith(sep) ? DIST : DIST + sep)) {
      response.writeHead(403).end();
      return;
    }
    if (file.endsWith(sep)) {
      file = join(file, 'index.html');
    }
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

const failures: string[] = [];

function expect(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) {
    failures.push(what);
  }
}

/** A page whose foreign requests are recorded and aborted, and whose CSP violations are kept. */
async function open(
  browser: Browser,
  url: string,
  origin: string,
  options: BrowserContextOptions,
  init?: () => void,
): Promise<{ page: Page; foreign: string[]; violations: () => Promise<string[]> }> {
  const context = await browser.newContext(options);
  const foreign: string[] = [];
  await context.route('**/*', (route) => {
    const requested = route.request().url();
    if (new URL(requested).origin === origin) {
      return route.continue();
    }
    foreign.push(requested);
    return route.abort();
  });
  if (options.javaScriptEnabled !== false) {
    await context.addInitScript(() => {
      const seen: string[] = [];
      Object.defineProperty(window, '__cspViolations', { value: seen });
      document.addEventListener('securitypolicyviolation', (event) => {
        seen.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
  }
  if (init !== undefined) {
    await context.addInitScript(init);
  }
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  return {
    page,
    foreign,
    violations: () =>
      page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations),
  };
}

async function themeSequence(page: Page, clicks: number): Promise<string> {
  const seen: string[] = [];
  for (let i = 0; i < clicks; i += 1) {
    await page.click('#theme-toggle');
    seen.push((await page.getAttribute('html', 'data-theme')) ?? '');
  }
  return seen.join(',');
}

const server = await serve();
const url = `${server.origin}${BASE}`;
const chromePath = process.env['CHROME_PATH'];
const browser = await chromium.launch(
  chromePath === undefined ? { channel: 'chrome' } : { executablePath: chromePath },
);
try {
  // F16: same-origin only, under the page's own CSP, and the self-hosted fonts load.
  const desktop = await open(browser, url, server.origin, {});
  const fontsLoaded = await desktop.page.evaluate(async () => {
    await document.fonts.ready;
    return ['IBM Plex Sans', 'IBM Plex Mono'].filter((family) =>
      [...document.fonts].some(
        (face) => face.family.replaceAll('"', '') === family && face.status === 'loaded',
      ),
    );
  });
  expect(
    desktop.foreign.length === 0,
    `no request to another origin (${desktop.foreign.join(', ')})`,
  );
  const violations = await desktop.violations();
  expect(violations.length === 0, `no CSP violation (${violations.join(', ')})`);
  expect(
    fontsLoaded.length === 2,
    `IBM Plex Sans and Mono load from the site (${fontsLoaded.join(', ')})`,
  );
  const csp = await desktop.page.evaluate(
    () =>
      document
        .querySelector('meta[http-equiv="content-security-policy"]')
        ?.getAttribute('content') ?? null,
  );
  expect(csp?.includes("default-src 'self'") === true, "the page carries default-src 'self'");

  // F15: nothing scrolls sideways on narrow phones.
  for (const width of [320, 360]) {
    const phone = await open(browser, url, server.origin, {
      viewport: { width, height: 740 },
      isMobile: true,
      hasTouch: true,
    });
    const { scroll, client } = await phone.page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(
      scroll <= client,
      `no horizontal scroll at ${width} px (scrollWidth ${scroll}, clientWidth ${client})`,
    );
  }

  // F14: the cycle keeps going when storage throws, and matches the cycle with storage.
  const blocked = await open(browser, url, server.origin, {}, () => {
    const refuse = (): never => {
      throw new DOMException('blocked', 'SecurityError');
    };
    Storage.prototype.getItem = refuse;
    Storage.prototype.setItem = refuse;
  });
  const blockedCycle = await themeSequence(blocked.page, 3);
  expect(
    blockedCycle === 'light,dark,system',
    `blocked-storage cycle is light,dark,system (${blockedCycle})`,
  );
  const stored = await open(browser, url, server.origin, {});
  const storedCycle = await themeSequence(stored.page, 3);
  expect(storedCycle === 'light,dark,system', `stored cycle is light,dark,system (${storedCycle})`);

  const noJs = await open(browser, url, server.origin, { javaScriptEnabled: false });
  expect(!(await noJs.page.isVisible('#theme-toggle')), 'the toggle is hidden without JS');
} finally {
  await browser.close();
  server.close();
}

if (failures.length > 0) {
  console.error(`site check: ${failures.length} failed`);
  process.exit(1);
}
console.log('site check: all passed');
