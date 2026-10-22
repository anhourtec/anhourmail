// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

import { type APIRequestContext, expect, type Page, test as base } from "@playwright/test";

export type E2eUsers = {
  run: string;
  password: string;
  accountName: string;
  users: Record<"globalAdmin" | "reportsReader" | "owner" | "member" | "userAdmin", string>;
};

export const urls = {
  site: process.env.SITE_URL ?? "http://localhost:43100",
  app: process.env.APP_URL ?? "http://localhost:43200",
  webmail: process.env.WEBMAIL_URL ?? "http://localhost:43300",
};

export const e2eUsers = (): E2eUsers => JSON.parse(readFileSync("test-results/e2e-users.json", "utf8")) as E2eUsers;

/** Fails the test on any console error or uncaught page error. */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await use(errors);
    expect(errors, "console errors").toEqual([]);
  },
});

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${urls.app}/sign-in`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

/**
 * The console navigation. On small screens it lives in a drawer behind "Open navigation", so open it first; on
 * wide screens the sidebar is always there.
 */
export async function openNav(page: Page) {
  const menu = page.getByRole("button", { name: "Open navigation" });
  if (await menu.isVisible()) await menu.click();
  return page.getByRole("navigation", { name: "Console" });
}

/** Signs out through the person's menu in the header. */
export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

export { expect };

const mailpit = `http://localhost:${process.env.MAILPIT_UI_PORT ?? "43026"}`;

/** Waits for a message to `to` in Mailpit (dev mail sink) and returns the first URL matching `pattern`. */
export async function linkFromMail(request: APIRequestContext, to: string, pattern: RegExp): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const search = (await (
          await request.get(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
        ).json()) as { messages?: { ID: string }[] };
        for (const m of search.messages ?? []) {
          const msg = (await (await request.get(`${mailpit}/api/v1/message/${m.ID}`)).json()) as { Text: string };
          link = pattern.exec(msg.Text)?.[0];
          if (link) return true;
        }
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return link ?? "";
}
