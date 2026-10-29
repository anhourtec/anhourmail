// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Archive works in a new mailbox: the run's own fresh mailbox (tests/e2e fixtures) has an Archive folder from the
 * mail server's default folders (ADR-0014), and archiving a message with the `e` shortcut takes it out of the Inbox
 * and into Archive. The message comes from a demo mailbox (local delivery only; rule 19). Demo passwords are read
 * from the local credentials.md and never printed.
 */
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

const folder = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: new RegExp(`^${name}(, \\d+)?$`) });

test("archiving in a new mailbox moves the message into its Archive folder @desktop-only", async ({
  page,
  browser,
  consoleErrors,
}) => {
  test.setTimeout(120_000);
  const tag = `archive-${Date.now().toString(36)}`;
  const me = e2eUsers().recipient;
  await signInWebmail(page, me.address, me.password);
  await expect(folder(page, "Archive")).toBeVisible();

  const other = await browser.newContext();
  const sender = await other.newPage();
  await signInWebmail(sender, OWNER, demoPassword(OWNER));
  await sender.getByRole("button", { name: "New email" }).click();
  const outgoing = sender.getByRole("dialog", { name: "New message" });
  await outgoing.getByLabel("To", { exact: true }).fill(`${me.address},`);
  await outgoing.getByLabel("Subject").fill(`Keep ${tag}`);
  const body = outgoing.getByRole("textbox", { name: "Message", exact: true });
  await expect(body).toHaveAttribute("contenteditable", "true");
  await body.fill("For the archive.");
  await outgoing.getByRole("button", { name: "Send" }).click();
  await expect(sender.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible();
  await other.close();
  await page.bringToFront();

  const inbox = page.getByRole("listbox", { name: "Inbox messages" });
  const row = inbox.getByRole("option", { name: new RegExp(`Keep ${tag}`) });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  const reader = page.getByRole("region", { name: "Message" });
  await expect(reader.getByRole("heading", { name: `Keep ${tag}` })).toBeVisible();
  await page.keyboard.press("e");
  await expect(page.getByRole("status").filter({ hasText: "Archived." })).toBeVisible();
  await expect(row).toHaveCount(0);

  await folder(page, "Archive").click();
  await expect(
    page.getByRole("listbox", { name: "Archive messages" }).getByRole("option", { name: new RegExp(`Keep ${tag}`) }),
  ).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
