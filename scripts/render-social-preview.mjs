#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Renders the GitHub social preview (1280 × 640 PNG) from the brand assets (CLAUDE.md rule 53): the dark-surface
 * logo and the tagline in General Sans Medium on the brand navy, with soft blue and cyan light behind. No third-party
 * marks. The maintainer uploads it by hand (GitHub → Settings → General → Social preview; there is no API).
 *
 *   node scripts/render-social-preview.mjs
 *
 * Writes packages/ui/assets/brand/github/social-preview.png. It sits in a sub-folder, so `npm run brand:sync`
 * doesn't copy it into the apps. Uses the Playwright Chromium the e2e suite already installs (no new dependency),
 * with the self-hosted font file, so the text renders the same on every machine.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

const BRAND = "packages/ui/assets/brand";
const OUT = path.join(BRAND, "github", "social-preview.png");
const FONT = "packages/ui/src/fonts/GeneralSans-Medium.woff2";
const WIDTH = 1280;
const HEIGHT = 640;
const TAGLINE = "Private, fast hosted email";

// Brand colours (packages/ui/assets/brand/README.md "Colours"): navy background, blue and cyan envelope tones.
const NAVY = "#070D18";
const BLUE = "0, 119, 200";
const CYAN = "56, 206, 255";

const b64 = (file) => readFileSync(file).toString("base64");

const html = `<!doctype html>
<html><head><style>
  @font-face { font-family: "General Sans"; font-weight: 500; src: url(data:font/woff2;base64,${b64(FONT)}) format("woff2"); }
  html, body { margin: 0; }
  body {
    width: ${String(WIDTH)}px; height: ${String(HEIGHT)}px; overflow: hidden; background: ${NAVY};
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 44px;
    background-image:
      radial-gradient(ellipse 620px 420px at 18% 10%, rgba(${BLUE}, 0.32), transparent 70%),
      radial-gradient(ellipse 560px 380px at 86% 96%, rgba(${CYAN}, 0.18), transparent 70%);
  }
  img { width: 760px; height: auto; display: block; }
  p {
    margin: 0; font-family: "General Sans", sans-serif; font-weight: 500; font-size: 46px; letter-spacing: -0.01em;
    color: rgba(255, 255, 255, 0.82);
  }
</style></head>
<body>
  <img alt="" src="data:image/svg+xml;base64,${b64(path.join(BRAND, "anhourmail-logo-dark.svg"))}">
  <p>${TAGLINE}</p>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.locator("img").evaluate((img) => img.decode());
  // Evaluated in the page (strings, so this Node script needs no browser globals).
  await page.evaluate("document.fonts.ready.then(() => true)");
  const loaded = await page.evaluate(`document.fonts.check('500 46px "General Sans"')`);
  if (!loaded) throw new Error("General Sans did not load; the preview would fall back to a system font.");
  const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, png);
  console.log(`${OUT}: ${String(WIDTH)} × ${String(HEIGHT)}, ${String(png.length)} bytes`);
} finally {
  await browser.close();
}
