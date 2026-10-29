// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail folder counts follow every change without a page refresh: a new draft and a discarded one (Drafts), mail
 * arriving from another mailbox (the automatic refresh), reading and marking unread (Inbox), and moving to Trash then
 * deleting forever (both folders). Uses the run's own fresh mailbox (tests/e2e fixtures), so its counts start at
 * zero; the message comes from a demo mailbox (local delivery only; rule 19). Demo passwords are read from the local
 * credentials.md and never printed.
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

/** A sidebar folder: its accessible name is "Drafts" with nothing to count, "Drafts, 2" otherwise. */
const folder = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: new RegExp(`^${name}(, \\d+)?$`) });

/** The count a folder shows now (0 when it shows none). */
const countOf = async (page: Page, name: string) =>
  Number(/, (\d+)$/.exec((await folder(page, name).getAttribute("aria-label")) ?? "")?.[1] ?? 0);

const expectCount = async (page: Page, name: string, count: number, timeout?: number) => {
  await expect(folder(page, name)).toHaveAccessibleName(count > 0 ? `${name}, ${String(count)}` : name, {
    ...(timeout ? { timeout } : {}),
  });
};

test("folder counts follow drafts, new mail, reading, moving and deleting without a refresh @desktop-only", async ({
  page,
  browser,
  consoleErrors,
}) => {
  test.setTimeout(120_000);
  const tag = `counts-${Date.now().toString(36)}`;
  const me = e2eUsers().recipient;
  await signInWebmail(page, me.address, me.password);
  await expectCount(page, "Drafts", 0);
  await expectCount(page, "Inbox", 0);

  // A new draft adds one to Drafts as soon as it is saved; discarding it takes it off again.
  await page.getByRole("button", { name: "New email" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByLabel("Subject").fill(`Draft ${tag}`);
  await expect(composer.getByText("Draft saved")).toBeVisible({ timeout: 10_000 });
  await expectCount(page, "Drafts", 1);
  await composer.getByRole("button", { name: "Discard draft" }).click();
  await expect(composer).toBeHidden();
  await expectCount(page, "Drafts", 0);
  // The discarded draft is in Trash now; whatever Trash shows is where its count starts.
  const trash = await countOf(page, "Trash");

  // Mail from another mailbox shows up in the Inbox count by itself (the automatic refresh).
  const other = await browser.newContext();
  const sender = await other.newPage();
  await signInWebmail(sender, OWNER, demoPassword(OWNER));
  await sender.getByRole("button", { name: "New email" }).click();
  const outgoing = sender.getByRole("dialog", { name: "New message" });
  await outgoing.getByLabel("To", { exact: true }).fill(`${me.address},`);
  await outgoing.getByLabel("Subject").fill(`Counts ${tag}`);
  const body = outgoing.getByRole("textbox", { name: "Message", exact: true });
  await expect(body).toHaveAttribute("contenteditable", "true");
  await body.fill("Counting.");
  await outgoing.getByRole("button", { name: "Send" }).click();
  await expect(sender.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible();
  await other.close();
  await page.bringToFront();
  await expectCount(page, "Inbox", 1, 60_000);

  // Opening it reads it: the Inbox count drops at once. Marking it unread brings it back.
  const inbox = page.getByRole("listbox", { name: "Inbox messages" });
  await inbox.getByRole("option", { name: new RegExp(`Counts ${tag}`) }).click();
  const reader = page.getByRole("region", { name: "Message" });
  await expect(reader.getByRole("heading", { name: `Counts ${tag}` })).toBeVisible();
  await expectCount(page, "Inbox", 0);
  await page.keyboard.press("Shift+U");
  await expectCount(page, "Inbox", 1);

  // Moving the unread message to Trash moves its count too; deleting it forever clears Trash.
  await reader.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Moved to Trash." })).toBeVisible();
  await expectCount(page, "Inbox", 0);
  await expectCount(page, "Trash", trash + 1);
  await folder(page, "Trash").click();
  await page
    .getByRole("listbox", { name: "Trash messages" })
    .getByRole("option", { name: new RegExp(`Counts ${tag}`) })
    .click();
  await expect(reader.getByRole("heading", { name: `Counts ${tag}` })).toBeVisible();
  // Opening it in Trash reads it; unread again, deleting it forever takes it off Trash's count.
  await expectCount(page, "Trash", trash);
  await page.keyboard.press("Shift+U");
  await expectCount(page, "Trash", trash + 1);
  await reader.getByRole("button", { name: "Delete forever" }).click();
  await page
    .getByRole("dialog", { name: /Delete this conversation forever/ })
    .getByRole("button", { name: "Delete forever" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Deleted forever." })).toBeVisible();
  await expectCount(page, "Trash", trash);
  expect(consoleErrors).toEqual([]);
});
