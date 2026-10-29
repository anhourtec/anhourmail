// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Staff support access (ADR-0023): a Support Administrator opens a customer account read-only from Platform → account
 * with a reason, sees the banner on every page, browses People and Mailboxes, is refused a change (403) and other
 * accounts (404), and ends it. The account's Owner then sees it in their audit log as Anhourtec staff. Each browser
 * project has its own account (scripts/e2e-fixtures.ts).
 */
import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { e2eUsers, expect, SIGN_IN_TIMEOUT, signIn, signOut, test, urls } from "./fixtures";

const banner = (page: Page) => page.getByRole("region", { name: "Support access" });

/** A fresh sign-in counts as the step-up; if the server asks anyway, confirm with the console password. */
async function confirmIfAsked(page: Page, password: string) {
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect
    .poll(async () => (await confirm.isVisible()) || (await banner(page).isVisible()), { timeout: SIGN_IN_TIMEOUT })
    .toBe(true);
  if (await confirm.isVisible()) {
    await confirm.getByLabel("Console password").fill(password);
    await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  }
}

test("a Support Administrator opens an account read-only, is refused changes, ends it; the Owner sees it", async ({
  page,
}, testInfo) => {
  const u = e2eUsers();
  const a = u.actAs[testInfo.project.name] ?? { accountName: "", accountId: "", owner: "", member: "" };
  const reason = `${u.run}: the owner asked why their invite isn't arriving`;

  await signIn(page, u.users.supportAdmin, u.password);
  await page.goto(`${urls.app}/platform/accounts`);
  await page.getByLabel("Search accounts").fill(a.accountName);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: a.accountName }).click();
  await expect(page.getByRole("heading", { name: a.accountName, level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Open with support access" }).click();
  const dialog = page.getByRole("dialog", { name: "Open this account with support access" });
  await expect(dialog.getByRole("button", { name: "Open read-only" })).toBeDisabled();
  await dialog.getByLabel("Reason").fill(reason);
  await dialog.getByRole("button", { name: "Open read-only" }).click();
  await confirmIfAsked(page, u.password);

  // The banner on every page; People and Mailboxes are readable.
  await expect(banner(page)).toContainText(`You're acting in ${a.accountName} as Anhourtec support — read-only`);
  await expect(page).toHaveURL(new RegExp(`/accounts/${a.accountId}/people`));
  await expect(page.getByText(a.owner).first()).toBeVisible();
  await page.goto(`${urls.app}/accounts/${a.accountId}/mailboxes`);
  await expect(page.getByRole("heading", { name: "Mailboxes", level: 1 })).toBeVisible();
  await expect(banner(page)).toBeVisible();

  // Changes are refused (403), other accounts are a 404, staff pages are closed while acting.
  const api = (method: "PATCH" | "GET", path: string, data?: unknown) =>
    page.request.fetch(`${urls.app}${path}`, { method, headers: { origin: urls.app }, ...(data ? { data } : {}) });
  expect((await api("PATCH", `/api/accounts/${a.accountId}/people/${randomUUID()}`, { role: "owner" })).status()).toBe(
    403,
  );
  expect((await api("GET", `/api/accounts/${randomUUID()}/mailboxes`)).status()).toBe(404);
  expect((await api("GET", "/api/platform/accounts")).status()).toBe(403);
  await page.goto(`${urls.app}/platform/accounts`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();

  // End: back to the staff view of the account.
  await page.goto(`${urls.app}/accounts/${a.accountId}/people`);
  await banner(page).getByRole("button", { name: "End support access", exact: true }).click();
  await expect(page.getByRole("heading", { name: a.accountName, level: 1 })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  expect((await api("GET", `/api/accounts/${a.accountId}/mailboxes`)).status()).toBe(404);
  await signOut(page);

  // The Owner sees every step as Anhourtec staff in their audit log.
  await signIn(page, a.owner, u.password);
  await page.goto(`${urls.app}/accounts/${a.accountId}/audit?actor=staff`);
  await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();
  for (const action of ["Anhourtec support access started", "Anhourtec support access ended", "Role changed"]) {
    await expect(page.getByText(action).first()).toBeVisible();
  }
  // The actor column on wide screens, the line under the action on narrow ones: whichever is shown.
  await expect(page.getByText("Anhourtec staff").filter({ visible: true }).first()).toBeVisible();
  await expect(
    page
      .getByText(/Support access · Support Administrator/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
});

test("other staff roles and customers can't start support access", async ({ page }) => {
  const u = e2eUsers();
  const start = async () =>
    (
      await page.request.post(`${urls.app}/api/platform/accounts/${randomUUID()}/act-as`, {
        headers: { origin: urls.app },
        data: { reason: "e2e: not allowed to do this" },
      })
    ).status();
  await signIn(page, u.users.reportsReader, u.password);
  expect(await start()).toBe(403);
  await signOut(page);
  await signIn(page, u.users.owner, u.password);
  expect(await start()).toBe(403);
  expect((await page.request.delete(`${urls.app}/api/me/act-as`, { headers: { origin: urls.app } })).status()).toBe(
    404,
  );
});
