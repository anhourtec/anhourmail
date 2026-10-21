// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

import { expect, type Page, test as base } from "@playwright/test";

export type E2eUsers = {
  run: string;
  password: string;
  accountName: string;
  users: Record<"globalAdmin" | "reportsReader" | "owner" | "member", string>;
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

export { expect };
