// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Profile photos, one source shown everywhere (ADR-0022, CLAUDE.md rule 61): a photo uploaded on the console Profile
 * page shows in the app bar at once and in the webmail of the person's own mailbox; one uploaded in webmail Settings →
 * Account shows in the console app bar when that tab is shown again (no reload); removing it brings back the initials
 * in both. Uses this run's own person and mailbox (scripts/e2e-fixtures.ts), never demo data.
 */
import type { Page, TestInfo } from "@playwright/test";

import { e2eUsers, expect, signIn, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

test.use({ trace: "off" });

/** 96×64 solid PNGs (blue, then orange): cropped to a square by the browser, re-encoded by the server. */
const BLUE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAMAAADS6oI8AAAAA1BMVEUebsjfA78LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVRYw+3BMQEAAADCoPVP7W0HoAAAAAAAAN4AGEAAAVgzK50AAAAASUVORK5CYII=",
  "base64",
);
const ORANGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAMAAADS6oI8AAAAA1BMVEXceB4+AD8TAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVRYw+3BMQEAAADCoPVP7W0HoAAAAAAAAN4AGEAAAVgzK50AAAAASUVORK5CYII=",
  "base64",
);
const png = (name: string, buffer: Buffer) => ({ name, mimeType: "image/png", buffer });

const who = (info: TestInfo) => {
  const a = e2eUsers().avatars[info.project.name];
  if (!a) throw new Error(`no photos fixture for ${info.project.name}`);
  return a;
};

/** The console app bar's avatar (the "Your account" button). */
const appBarPhoto = (page: Page) => page.getByRole("button", { name: "Your account" }).locator("img");

async function signInWebmail(page: Page, address: string, password: string) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

/** The webmail sidebar's tile for a mailbox (a drawer below 1024px: opened first). */
async function mailboxTile(page: Page, address: string) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
  return page.getByRole("radio", { name: address });
}

/** What a tab does when the person comes back to it: the page sees it shown and focused again. */
async function comeBack(page: Page) {
  await page.bringToFront();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });

async function openAccountSettings(page: Page) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings(page)).toBeVisible();
  await settings(page)
    .getByRole("tab", { name: /^Account/ })
    .click();
  await expect(settings(page).getByRole("tabpanel").getByRole("heading", { name: "Account", level: 2 })).toBeVisible();
}

test("a photo set in the console shows in the webmail, one set in the webmail shows in the console, and removing brings back initials", async ({
  page,
  context,
  // Requested so the run fails on any console error, CSP violation or page error.
  consoleErrors: _consoleErrors,
}, info) => {
  const { password } = e2eUsers();
  const me = who(info);

  // Console: upload on the Profile page; the app bar shows it at once.
  await signIn(page, me.person, password);
  await page.goto(`${urls.app}/profile`);
  await expect(appBarPhoto(page)).toHaveCount(0);
  await page.locator('input[type="file"]').setInputFiles(png("blue.png", BLUE));
  await expect(page.getByRole("status").filter({ hasText: "Photo saved." })).toBeVisible();
  await expect(appBarPhoto(page)).toHaveAttribute("src", /^\/api\/avatars\/person\/[^/?]+\?v=[0-9a-f]{16}$/);
  const consoleSrc = await appBarPhoto(page).getAttribute("src");
  await expect(page.getByRole("button", { name: "Change your photo" })).toBeVisible();

  // The photo is served same-origin as a sandboxed WebP.
  const res = await page.request.get(`${urls.app}${consoleSrc ?? ""}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/webp");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");

  // Webmail of the person's own mailbox: the sidebar tile shows the same photo (its own origin's URL).
  const mail = await context.newPage();
  await signInWebmail(mail, me.mailbox, me.mailboxPassword);
  const tile = await mailboxTile(mail, me.mailbox);
  const version = /v=([0-9a-f]{16})/.exec(consoleSrc ?? "")?.[1] ?? "none";
  await expect(tile.locator("img")).toHaveAttribute(
    "src",
    new RegExp(`^/api/webmail/avatars/person/.+\\?v=${version}$`),
  );

  // Webmail: change it in Settings → Account → You; the tile updates at once…
  await openAccountSettings(mail);
  await expect(settings(mail).getByText("Sender name, as people see it on your mail")).toBeVisible();
  await settings(mail).locator('input[type="file"]').setInputFiles(png("orange.png", ORANGE));
  await expect(settings(mail).getByRole("status").filter({ hasText: "Photo saved." })).toBeVisible();
  await settings(mail).getByRole("button", { name: "Close settings" }).last().click();
  await expect((await mailboxTile(mail, me.mailbox)).locator("img")).not.toHaveAttribute(
    "src",
    new RegExp(`v=${version}$`),
  );

  // …and the console tab, still open, shows the new one when it is shown again (no reload).
  await comeBack(page);
  await expect(appBarPhoto(page)).toHaveAttribute("src", /\?v=[0-9a-f]{16}$/);
  await expect(appBarPhoto(page)).not.toHaveAttribute("src", consoleSrc ?? "");

  // Remove in the console: initials in the app bar, then in the webmail when its tab is shown again.
  await page.getByRole("button", { name: "Remove your photo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Photo removed." })).toBeVisible();
  await expect(appBarPhoto(page)).toHaveCount(0);
  await comeBack(mail);
  await expect((await mailboxTile(mail, me.mailbox)).locator("img")).toHaveCount(0);
});

test("the console refuses a file that isn't a PNG, JPEG or WebP", async ({
  page,
  consoleErrors: _consoleErrors,
}, info) => {
  const { password } = e2eUsers();
  await signIn(page, who(info).person, password);
  await page.goto(`${urls.app}/profile`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "x.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
  });
  await expect(page.getByRole("alert").filter({ hasText: "Use a PNG, JPEG or WebP image." })).toBeVisible();
  await expect(appBarPhoto(page)).toHaveCount(0);
});
