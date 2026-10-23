#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Renders the email logo PNGs from the brand SVGs (CLAUDE.md rule 53; docs/internal/branding.md "Transactional
 * email"). Mail clients don't show SVG, so system emails embed these PNGs as inline (CID) attachments — never a remote
 * URL. One for light surfaces, one for dark (swapped by the email's dark-mode block), each at 2x for sharp screens.
 *
 *   node scripts/render-email-logo.mjs && npm run brand:sync
 *
 * Uses the Playwright Chromium the e2e suite already installs (`npx playwright install chromium`), so no new
 * dependency. `brand:sync` then regenerates packages/adapters/src/mail/logo.generated.ts from the PNGs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

const BRAND = "packages/ui/assets/brand";
/** Display size in the email (CSS px); the PNG is twice this. The wordmark's aspect ratio is 3157 × 308. */
const WIDTH = 200;
const HEIGHT = 20;
const SCALE = 2;

const variants = [
  { svg: "anhourmail-logo-light.svg", png: "email/anhourmail-logo-email-light.png" },
  { svg: "anhourmail-logo-dark.svg", png: "email/anhourmail-logo-email-dark.png" },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: SCALE });
  for (const v of variants) {
    const svg = readFileSync(path.join(BRAND, v.svg)).toString("base64");
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">` +
        `<img src="data:image/svg+xml;base64,${svg}" width="${String(WIDTH)}" style="display:block"></body></html>`,
    );
    await page.locator("img").evaluate((img) => img.decode());
    const png = await page.screenshot({
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      omitBackground: true,
      type: "png",
    });
    writeFileSync(path.join(BRAND, v.png), png);
    console.log(`${v.png}: ${String(png.length)} bytes`);
  }
} finally {
  await browser.close();
}
