// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Content-Security-Policy on every origin (CLAUDE.md rule 29): webmail, console and site pages each carry exactly one
 * policy, nonce-based with `'strict-dynamic'`, same-origin only and never framed, and the page's own scripts carry
 * that nonce. API responses carry the data-only policy. Violations on real pages fail every journey through the
 * `consoleErrors` fixture; here the headers themselves are pinned.
 */
import type { APIResponse } from "@playwright/test";

import { expect, test, urls } from "./fixtures";

const NONCE_SCRIPT = /^script-src 'self' 'nonce-([A-Za-z0-9+/]{22}==)' 'strict-dynamic'( 'unsafe-eval')?$/;

/** Every Content-Security-Policy header on a response (a second one would only ever tighten, but we serve one). */
const cspHeaders = (res: APIResponse) =>
  res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "content-security-policy")
    .map((h) => h.value);

function directives(csp: string): Map<string, string> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.split(" ")[0] ?? "", d]),
  );
}

/** Asserts one nonce policy with the shared strict directives; returns its directives and nonce. */
function expectNoncePolicy(res: APIResponse) {
  const all = cspHeaders(res);
  expect(all).toHaveLength(1);
  const d = directives(all[0] ?? "");
  const nonce = NONCE_SCRIPT.exec(d.get("script-src") ?? "")?.[1];
  expect(nonce, `script-src in ${all[0] ?? ""}`).toBeTruthy();
  expect(d.get("default-src")).toBe("default-src 'self'");
  expect(d.get("connect-src")).toBe("connect-src 'self'");
  expect(d.get("object-src")).toBe("object-src 'none'");
  expect(d.get("base-uri")).toBe("base-uri 'none'");
  expect(d.get("form-action")).toBe("form-action 'self'");
  expect(d.get("frame-ancestors")).toBe("frame-ancestors 'none'");
  return { d, nonce: nonce ?? "" };
}

/** The page's scripts carry the response's nonce, and nothing in the policy names another origin. */
async function expectNonceApplied(res: APIResponse, nonce: string) {
  const html = await res.text();
  expect(html).toContain(`nonce="${nonce}"`);
  expect(cspHeaders(res)[0]).not.toMatch(/https?:|\*/);
}

test("webmail pages carry exactly one nonce CSP", async ({ request }) => {
  const res = await request.get(`${urls.webmail}/sign-in`);
  expect(res.status()).toBe(200);
  const { d, nonce } = expectNoncePolicy(res);
  expect(d.get("frame-src")).toBe("frame-src 'self'");
  await expectNonceApplied(res, nonce);
  // A fresh nonce per response.
  const again = expectNoncePolicy(await request.get(`${urls.webmail}/sign-in`));
  expect(again.nonce).not.toBe(nonce);
});

test("console pages carry exactly one strict nonce CSP", async ({ request }) => {
  for (const path of ["/sign-in", "/sign-up"]) {
    const res = await request.get(`${urls.app}${path}`);
    expect(res.status()).toBe(200);
    const { d, nonce } = expectNoncePolicy(res);
    expect(d.get("img-src")).toBe("img-src 'self' data:");
    expect(d.get("font-src")).toBe("font-src 'self'");
    expect(d.has("frame-src")).toBe(false);
    await expectNonceApplied(res, nonce);
  }
  // A client can't choose the nonce.
  const forged = await request.get(`${urls.app}/sign-in`, { headers: { "x-nonce": "AAAAAAAAAAAAAAAAAAAAAA==" } });
  expect(cspHeaders(forged)[0]).not.toContain("AAAAAAAAAAAAAAAAAAAAAA==");
});

test("site pages carry exactly one strict nonce CSP", async ({ request }) => {
  for (const path of ["/", "/pricing", "/docs"]) {
    const res = await request.get(`${urls.site}${path}`);
    expect(res.status()).toBe(200);
    const { d, nonce } = expectNoncePolicy(res);
    expect(d.get("img-src")).toBe("img-src 'self' data:");
    await expectNonceApplied(res, nonce);
  }
});

test("API responses carry exactly one data-only CSP", async ({ request }) => {
  for (const url of [
    `${urls.app}/api/health`,
    `${urls.app}/api/me`,
    `${urls.webmail}/api/webmail/session`,
    `${urls.site}/api/search?query=imap`,
  ]) {
    expect(cspHeaders(await request.get(url)), url).toEqual(["default-src 'none'; frame-ancestors 'none'"]);
  }
});

test("site docs search runs under the policy", async ({ page, consoleErrors }) => {
  await page.goto(`${urls.site}/docs`);
  // The sidebar's search button on wide screens, the header's on phones.
  const open = page.getByRole("button", { name: /^(Search|Open Search)/ }).filter({ visible: true });
  await open.first().click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await dialog.getByRole("combobox", { name: "Search" }).fill("imap");
  // Results come from our own /api/search under connect-src 'self'.
  await expect(dialog.getByRole("option").first()).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
