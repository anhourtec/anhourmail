// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Account-wide Safe senders (ADR-0032 §1): the demo Family Owner adds an entry in the console, sees it on the list, and
 * the same mailbox's webmail Settings shows it read-only under "Added by your organisation"; then it is removed. A
 * Read-only person sees the list without the form; a Member gets the 403 page and no navigation entry. Entries are
 * unique per run and project, and removed at the end. Demo passwords are read from credentials.md, never printed.
 */
import type { Page } from "@playwright/test";

import { demoPassword } from "../support/demo-credentials";
import { e2eUsers, expect, SIGN_IN_TIMEOUT, signIn, test, urls } from "./fixtures";

const OWNER = "owner@demo-family.test";
const AUDITOR = "auditor@demo-family.test";
const MEMBER = "member@demo-family.test";

test.use({ trace: "off" });

/** The demo Family account's id, from the console's own links. */
async function accountId(page: Page): Promise<string> {
  const href = await page.locator('a[href^="/accounts/"]').first().getAttribute("href");
  const id = /^\/accounts\/([0-9a-f-]{36})/.exec(href ?? "")?.[1];
  if (!id) throw new Error("no account link on the console home");
  return id;
}

async function signInWebmail(page: Page, address: string, password: string) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

/** Opens webmail settings from the sidebar footer (a drawer below 1024px). */
async function openSettings(page: Page) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

test("an Owner adds an account safe sender; the mailbox's settings show it read-only", async ({
  page,
  consoleErrors: _errors,
}, info) => {
  const { run } = e2eUsers();
  const entry = `e2e-${run}-${info.project.name}.example`.toLowerCase();
  await signIn(page, OWNER, demoPassword(OWNER));
  const id = await accountId(page);
  // A run cut short earlier may have left this entry behind: start without it.
  const api = `${urls.app}/api/accounts/${id}/safe-senders`;
  const before = (await (await page.request.get(api)).json()) as { data: { entries: { id: string; entry: string }[] } };
  for (const e of before.data.entries.filter((x) => x.entry === entry)) {
    await page.request.delete(`${api}/${e.id}`, { headers: { origin: urls.app } });
  }
  await page.goto(`${urls.app}/accounts/${id}/safe-senders`);
  await expect(page.getByRole("heading", { name: "Safe senders", level: 1 })).toBeVisible();

  const field = page.getByLabel("Address or domain");
  await field.fill("not an address");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(/isn't an address or a domain/)).toBeVisible();
  await field.fill(` ${entry.toUpperCase()} `);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Added 1 entry. Every mailbox follows within a minute.")).toBeVisible();
  const row = page.getByRole("list", { name: "Account safe senders" }).getByRole("listitem").filter({ hasText: entry });
  await expect(row).toHaveCount(1);
  await expect(row.getByText("Domain", { exact: false })).toBeVisible();

  // The person's own webmail settings show it, read-only.
  await signInWebmail(page, OWNER, demoPassword(OWNER));
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: /^Junk and blocked senders/ }).click();
  const org = settings.getByRole("list", { name: "Safe senders added by your organisation" });
  await expect(org.getByText(entry, { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: `Remove ${entry}` })).toHaveCount(0);

  // Removed in the console: gone from the list.
  await page.goto(`${urls.app}/accounts/${id}/safe-senders`);
  await page.getByRole("button", { name: `Remove ${entry}` }).click();
  await page
    .getByRole("alertdialog", { name: `Remove ${entry}?` })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByRole("listitem").filter({ hasText: entry })).toHaveCount(0);
});

test("Read-only sees the list without changing it", async ({ page, consoleErrors: _errors }) => {
  await signIn(page, AUDITOR, demoPassword(AUDITOR));
  const id = await accountId(page);
  await page.goto(`${urls.app}/accounts/${id}/safe-senders`);
  await expect(page.getByRole("heading", { name: "Safe senders", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Address or domain")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  // The server refuses what the page hides (403).
  const res = await page.request.post(`${urls.app}/api/accounts/${id}/safe-senders`, {
    headers: { origin: urls.app },
    data: { entries: ["refused.example"] },
  });
  expect(res.status()).toBe(403);
});

// The 403 page is a real status, which the browser reports as a failed load: no console-error check here.
test("a Member has no Safe senders entry and gets the 403 page", async ({ page }) => {
  await signIn(page, OWNER, demoPassword(OWNER));
  const id = await accountId(page);
  await page.context().clearCookies();
  await signIn(page, MEMBER, demoPassword(MEMBER));
  await expect(page.locator(`a[href="/accounts/${id}/safe-senders"]`)).toHaveCount(0);
  const res = await page.goto(`${urls.app}/accounts/${id}/safe-senders`);
  expect(res?.status()).toBe(403);
});
