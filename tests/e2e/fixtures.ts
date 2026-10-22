// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

import { type APIRequestContext, expect, type Page, test as base } from "@playwright/test";

export type E2eUsers = {
  run: string;
  password: string;
  accountName: string;
  users: Record<"globalAdmin" | "reportsReader" | "owner" | "member" | "userAdmin", string>;
  /** A mailbox of this run's own (fresh mail-server allowance per run) for webmail send/receive journeys. */
  recipient: { address: string; password: string };
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

/** The console home: its greeting ("Good morning, Pat"; "Hello, Pat" before the browser's clock is read). */
export const homeHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: /^(Hello|Good (morning|afternoon|evening)), / });

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${urls.app}/sign-in`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(homeHeading(page)).toBeVisible();
}

/** The open flyout details panel (a modal dialog), by its name. */
export const panel = (page: Page, name: string | RegExp) =>
  page.getByRole("dialog", typeof name === "string" ? { name, exact: true } : { name });

/** After a reload the panel is server-rendered first; once the page is interactive, focus moves into it. */
export async function panelReady(page: Page, name: string | RegExp) {
  await expect(panel(page, name).locator(":focus")).toHaveCount(1);
}

/**
 * The console navigation. On small screens it lives in a drawer behind "Open navigation", so open it first; on
 * wide screens the left navigation is always there.
 */
export async function openNav(page: Page) {
  const menu = page.getByRole("button", { name: "Open navigation" });
  if (await menu.isVisible()) await menu.click();
  return page.getByRole("navigation", { name: "Console" });
}

/** The app bar's search box (behind "Open search" on small screens). */
export async function openSearch(page: Page) {
  const open = page.getByRole("button", { name: "Open search" });
  if (await open.isVisible()) await open.click();
  return page.getByRole("combobox", { name: "Search the console" });
}

/** Signs out through the person's menu in the app bar. */
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
