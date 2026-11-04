// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mail rules (ADR-0032 §2) in webmail Settings → Rules: the run's own mailbox adds a rule (subject contains a tag →
 * move to Archive, mark as read), a message from a demo mailbox with that subject lands in Archive, read, not in the
 * Inbox; a rule can't forward without a confirmed forwarding address; the rule is deleted at the end. Both
 * layouts also open the panel and editor and close it without saving (one mailbox's rules, so only desktop saves). Demo
 * passwords are read from credentials.md, never printed.
 */
import type { Page } from "@playwright/test";

import { demoPassword } from "../support/demo-credentials";
import { e2eUsers, expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

const OWNER = "owner@demo-family.test";

test.use({ trace: "off" });

async function signInWebmail(page: Page, address: string, password: string) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });

async function openRules(page: Page) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings(page)
    .getByRole("tab", { name: /^Rules/ })
    .click();
  await expect(settings(page).getByRole("tabpanel").getByRole("heading", { name: "Rules", level: 2 })).toBeVisible();
}

const folder = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: new RegExp(`^${name}(, \\d+)?$`) });

test("a rule moves matching new mail into Archive, marked read @desktop-only", async ({
  page,
  browser,
  consoleErrors: _errors,
}) => {
  test.setTimeout(120_000);
  const tag = `rule-${Date.now().toString(36)}`;
  const me = e2eUsers().recipient;
  await signInWebmail(page, me.address, me.password);
  await openRules(page);
  const panel = settings(page).getByRole("tabpanel");

  await panel.getByRole("button", { name: "Add rule" }).click();
  const editor = page.getByRole("dialog", { name: "Add rule" });
  await editor.getByLabel("Name").fill(`Sort ${tag}`);
  await editor.getByLabel("Condition 1", { exact: true }).selectOption("subject");
  await editor.getByLabel("Text for condition 1").fill(tag);
  await editor.getByLabel("Move to").selectOption({ label: "Archive" });
  await editor.getByLabel("Mark as read").check();
  // No confirmed forwarding address on this mailbox: forwarding can't be chosen.
  await expect(editor.getByLabel("Forward a copy")).toBeDisabled();
  await editor.getByRole("button", { name: "Check Inbox" }).click();
  await expect(editor.getByText("None of your recent Inbox messages match.")).toBeVisible();
  await editor.getByRole("button", { name: "Save rule" }).click();
  await expect(editor).toBeHidden();
  const list = panel.getByRole("list", { name: "Mail rules" });
  await expect(list.getByText(`Sort ${tag}`)).toBeVisible();
  await expect(list.getByText(`If Subject contains “${tag}”: Mark as read, move to Archive`)).toBeVisible();
  await settings(page).getByRole("button", { name: "Close settings" }).last().click();

  const other = await browser.newContext();
  const sender = await other.newPage();
  await signInWebmail(sender, OWNER, demoPassword(OWNER));
  await sender.getByRole("button", { name: "New email" }).click();
  const outgoing = sender.getByRole("dialog", { name: "New message" });
  await outgoing.getByLabel("To", { exact: true }).fill(`${me.address},`);
  await outgoing.getByLabel("Subject").fill(`Report ${tag}`);
  const body = outgoing.getByRole("textbox", { name: "Message", exact: true });
  await expect(body).toHaveAttribute("contenteditable", "true");
  await body.fill("Sorted by a rule.");
  await outgoing.getByRole("button", { name: "Send" }).click();
  await expect(sender.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible();
  await other.close();
  await page.bringToFront();

  await folder(page, "Archive").click();
  const row = page
    .getByRole("listbox", { name: "Archive messages" })
    .getByRole("option", { name: new RegExp(`Report ${tag}`) });
  await expect(async () => {
    await page.reload();
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await folder(page, "Archive").click();
    await expect(row).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  // Marked read by the rule: no unread marker on the row.
  await expect(row).not.toHaveAccessibleName(/unread/i);
  await folder(page, "Inbox").click();
  await expect(
    page.getByRole("listbox", { name: "Inbox messages" }).getByRole("option", { name: new RegExp(`Report ${tag}`) }),
  ).toHaveCount(0);

  await openRules(page);
  await settings(page)
    .getByRole("tabpanel")
    .getByRole("button", { name: `Delete Sort ${tag}` })
    .click();
  await page
    .getByRole("dialog", { name: `Delete Sort ${tag}?` })
    .getByRole("button", { name: "Delete rule" })
    .click();
  await expect(settings(page).getByRole("tabpanel").getByText("Rule deleted.")).toBeVisible();
});

test("the rules panel and its editor open and close without saving", async ({ page, consoleErrors: _errors }) => {
  const me = e2eUsers().recipient;
  await signInWebmail(page, me.address, me.password);
  await openRules(page);
  const panel = settings(page).getByRole("tabpanel");
  await panel.getByRole("button", { name: "Add rule" }).click();
  const editor = page.getByRole("dialog", { name: "Add rule" });
  await expect(editor.getByLabel("Name")).toBeVisible();
  await editor.getByRole("button", { name: "Add condition" }).click();
  await expect(editor.getByLabel("Condition 2", { exact: true })).toBeVisible();
  // Saving with nothing filled in is answered here, before anything is sent.
  await editor.getByRole("button", { name: "Save rule" }).click();
  await expect(editor.getByRole("alert")).toHaveText("Give the rule a name.");
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();
});
