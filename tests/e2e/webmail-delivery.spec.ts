// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Delivery problems after a send: an address on one of our domains that doesn't exist is refused by the mail server
 * while the message is held, without any bounce, so the webmail tells the sender which address and why (and says it
 * once, not again after the hold). A send to a real mailbox — the run's own fresh one — shows no such warning, before
 * or after the hold. Local delivery only (rule 19). Demo passwords are read from the local credentials.md and never
 * printed.
 */
import { randomBytes } from "node:crypto";

import { demoPassword } from "../support/demo-credentials";
import type { Page } from "@playwright/test";

import { e2eUsers, expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

const OWNER = "owner@demo-family.test";

// The message frame's sandbox blocks the trace recorder's injected script (see webmail.spec.ts): no trace here.
test.use({ trace: "off" });

async function signInWebmail(page: Page, address: string, password: string) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  // The Next.js dev indicator (dev builds only) can sit over controls.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

async function send(page: Page, to: string[], subject: string) {
  await page.getByRole("button", { name: "New email" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByLabel("To", { exact: true }).fill(`${to.join(", ")},`);
  await composer.getByLabel("Subject").fill(subject);
  const body = composer.getByRole("textbox", { name: "Message", exact: true });
  // The editor turns editable once the composer is ready.
  await expect(body).toHaveAttribute("contenteditable", "true");
  await body.fill("Delivery check.");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(composer).toBeHidden();
}

/** The delivery problem notice (it stays until dismissed). */
const notice = (page: Page) => page.getByRole("alert").filter({ hasText: "Not delivered to" });

test("names an address on our domain that doesn't exist; a real mailbox gets no warning", async ({
  page,
  consoleErrors,
}) => {
  test.setTimeout(90_000);
  const tag = randomBytes(4).toString("hex");
  const nobody = `nobody-${tag}@dev.test`;
  const me = e2eUsers().recipient;
  await signInWebmail(page, OWNER, demoPassword(OWNER));

  // Refused at once: the warning names the address, the reason in plain words and only a short code.
  await send(page, [me.address, nobody], `Delivery ${tag} partly`);
  await expect(page.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible();
  await expect(notice(page)).toHaveCount(1);
  await expect(notice(page)).toContainText(`Not delivered to ${nobody}`);
  await expect(notice(page)).toContainText("No mailbox with this address exists. (5.1.2)");
  await expect(notice(page)).not.toContainText("Mailbox does not exist");
  await expect(notice(page)).not.toContainText(me.address);
  // After the undo hold the check runs again: still one notice, not a second one for the same address.
  await page.waitForResponse((r) => r.url().endsWith("/api/webmail/send/status") && r.ok(), { timeout: 70_000 });
  await expect(notice(page)).toHaveCount(1);
  await notice(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(notice(page)).toHaveCount(0);

  // A real mailbox only: sent, and no warning before or after the hold.
  await send(page, [me.address], `Delivery ${tag} fine`);
  await expect(page.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible();
  const after = await page.waitForResponse((r) => r.url().endsWith("/api/webmail/send/status"), { timeout: 70_000 });
  expect(after.ok()).toBe(true);
  expect(((await after.json()) as { data: { undelivered: unknown[] } }).data.undelivered).toEqual([]);
  await expect(notice(page)).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});
