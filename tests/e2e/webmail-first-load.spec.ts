// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The webmail's first load (docs/internal/05-webmail.md "First load"): the folders and the Inbox's first window come
 * inside the page itself (no session, folder or list request on the way to the list), the webmail API says where its
 * server time went without naming anything, this browser keeps a copy of the first view (summaries only) for the
 * next visit, and signing out leaves no copy behind. Demo passwords come from the local credentials.md and are never
 * printed.
 */
import type { Page } from "@playwright/test";

import { demoPassword } from "../support/demo-credentials";

import { expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

const OWNER = "owner@demo-family.test";

/** The message frame's sandbox makes the trace recorder log a blocked-script error; see webmail.spec.ts. */
test.use({ trace: "off" });

/** The folder sidebar is a drawer below 1024px. */
async function showFolders(page: Page) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
}

/**
 * What IndexedDB holds for `address` (read from the page's own storage), or null: its format version and its bytes as
 * text, so a test can see nothing readable is stored.
 */
const cachedView = (page: Page, address: string) =>
  page.evaluate(
    (key) =>
      new Promise<{ v: unknown; text: string } | null>((resolve) => {
        const req = indexedDB.open("anhourmail-webmail", 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains("first-view")) req.result.createObjectStore("first-view");
        };
        req.onerror = () => {
          resolve(null);
        };
        req.onsuccess = () => {
          const get = req.result.transaction("first-view").objectStore("first-view").get(key);
          get.onsuccess = () => {
            req.result.close();
            const value = get.result as { v?: unknown; data?: unknown } | undefined;
            if (!value) {
              resolve(null);
              return;
            }
            const bytes = value.data instanceof ArrayBuffer ? new Uint8Array(value.data) : new Uint8Array(0);
            resolve({ v: value.v, text: new TextDecoder("latin1").decode(bytes) + JSON.stringify(value) });
          };
          get.onerror = () => {
            req.result.close();
            resolve(null);
          };
        };
      }),
    address,
  );

test("the inbox comes inside the page, a copy is kept for next time, and sign-out clears it", async ({
  page,
  consoleErrors,
}) => {
  const asked: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/api/webmail/")) asked.push(`${r.method()} ${path}`);
  });
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(OWNER);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword(OWNER));
  // Contacts are asked for only once the first view is painted: their answer carries the phase timings checked below.
  const later = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/webmail/contacts");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  const list = page.getByRole("listbox", { name: "Inbox messages" });
  await expect(list.getByRole("option", { name: /Your holds are ready for pickup/ })).toBeVisible();
  // Nothing on the way to the list asked the mail server: no session document, first-load, folder or list request
  // (what isn't needed for the list follows once it is painted).
  const before = [...asked];
  for (const path of ["GET /api/webmail/session", "GET /api/webmail/bootstrap", "POST /api/webmail/jmap"]) {
    expect(before).not.toContain(path);
  }

  const res = await later;
  const timing = (await res.allHeaders())["server-timing"] ?? "";
  expect(timing).toMatch(/^total;dur=[\d.]+/);
  for (const part of timing.split(", ")) expect(part).toMatch(/^[a-z]+;dur=[\d.]+(;desc="x\d+")?$/);
  expect(asked).not.toContain("GET /api/webmail/session");
  expect(asked).not.toContain("GET /api/webmail/bootstrap");

  // This browser keeps a copy of the first view, sealed under the session's key: nothing in it is readable.
  await expect.poll(() => cachedView(page, OWNER)).not.toBeNull();
  const copy = await cachedView(page, OWNER);
  expect(copy?.v).toBe(2);
  expect(copy?.text).not.toContain("Your holds are ready");
  expect(copy?.text).not.toContain("Westside Library");

  // The next visit opens on the list again without a first-load request of its own.
  asked.length = 0;
  const settled = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/webmail/contacts");
  const doc = await page.reload();
  await expect(list.getByRole("option", { name: /Your holds are ready for pickup/ })).toBeVisible();
  await settled;
  // The page carries mail summaries: neither it nor its RSC payload may be kept by a cache.
  expect((await doc?.allHeaders())?.["cache-control"]).toBe("no-store");
  const rsc = await page.request.get(page.url(), { headers: { rsc: "1" } });
  expect(rsc.headers()["cache-control"]).toBe("no-store");
  expect(asked).not.toContain("GET /api/webmail/bootstrap");
  expect(asked).not.toContain("GET /api/webmail/session");

  // A second tab of the same mailbox stays open while the first signs out.
  const other = await page.context().newPage();
  await other.goto(`${urls.webmail}/`);
  await expect(
    other.getByRole("listbox", { name: "Inbox messages" }).getByRole("option", { name: /Your holds are ready/ }),
  ).toBeVisible();

  // Sign out: no copy is left on this browser...
  await showFolders(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to your mailbox" })).toBeVisible();
  expect(await cachedView(page, OWNER)).toBeNull();
  // ...and the other tab, hidden and then closed afterwards, doesn't write one back. Read from a same-origin page that
  // doesn't load the app, so nothing of the app could clear or rewrite it on the way.
  await other.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
  });
  await other.waitForTimeout(1_000);
  await other.close({ runBeforeUnload: true });
  const bare = await page.context().newPage();
  await bare.goto(`${urls.webmail}/api/webmail/session`);
  expect(await cachedView(bare, OWNER)).toBeNull();
  await bare.close();
  expect(consoleErrors).toEqual([]);
});
