// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Templates (canned replies, ADR-0032 §3): the run's own mailbox adds one in Settings → Writing, inserts it from the
 * composer's Templates menu where the caret is, renames it, and deletes it. On phones the composer's Templates menu
 * opens. One mailbox's templates, so only desktop changes them.
 */
import type { Page } from "@playwright/test";

import { e2eUsers, expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

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

async function openWriting(page: Page) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings(page)
    .getByRole("tab", { name: /^Writing/ })
    .click();
  await expect(settings(page).getByRole("heading", { name: "Templates" })).toBeVisible();
}

test("a template is added, inserted from the composer, renamed and deleted @desktop-only", async ({
  page,
  consoleErrors: _errors,
}) => {
  const tag = Date.now().toString(36);
  const me = e2eUsers().recipient;
  await signInWebmail(page, me.address, me.password);
  await openWriting(page);

  await settings(page).getByRole("button", { name: "Add template" }).click();
  const dialog = page.getByRole("dialog", { name: "Add template" });
  await dialog.getByLabel("Name").fill(`Thanks ${tag}`);
  const body = dialog.getByRole("textbox", { name: "Template", exact: true });
  await expect(body).toHaveAttribute("contenteditable", "true");
  await body.click();
  await body.pressSequentially(`Thanks for writing ${tag}.`);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const list = settings(page).getByRole("list", { name: "Your templates" });
  await expect(list.getByText(`Thanks ${tag}`, { exact: true })).toBeVisible();
  await settings(page).getByRole("button", { name: "Close settings" }).last().click();

  await page.keyboard.press("c");
  const composer = page.getByRole("dialog", { name: "New message" });
  const message = composer.getByRole("textbox", { name: "Message", exact: true });
  await expect(message).toHaveAttribute("contenteditable", "true");
  await message.click();
  await message.pressSequentially("Hello. ");
  await composer.getByRole("button", { name: "Templates", exact: true }).click();
  await page
    .getByRole("menu", { name: "Templates" })
    .getByRole("menuitem", { name: `Thanks ${tag}` })
    .click();
  await expect(message).toContainText(`Hello. Thanks for writing ${tag}.`);
  await composer.getByRole("button", { name: "Discard draft" }).click();

  await openWriting(page);
  await list.getByRole("button", { name: `Edit Thanks ${tag}` }).click();
  const edit = page.getByRole("dialog", { name: "Edit template" });
  await edit.getByLabel("Name").fill(`Thank you ${tag}`);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(list.getByText(`Thank you ${tag}`, { exact: true })).toBeVisible();
  await list.getByRole("button", { name: `Delete Thank you ${tag}` }).click();
  await page
    .getByRole("dialog", { name: `Delete Thank you ${tag}?` })
    .getByRole("button", { name: "Delete template" })
    .click();
  await expect(settings(page).getByText("Template deleted.")).toBeVisible();
});

test("the composer's Templates menu opens", async ({ page, consoleErrors: _errors }) => {
  const me = e2eUsers().recipient;
  await signInWebmail(page, me.address, me.password);
  await page.getByRole("button", { name: "New email" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByRole("button", { name: "Templates", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Templates" }).getByText("Insert a template")).toBeVisible();
  await page.keyboard.press("Escape");
});
