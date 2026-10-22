// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail (Phase 4, slice 1): sign in with a mailbox address and password on the webmail origin, read the seeded
 * demo mail (`npm run db:seed -- --demo`), check that remote images stay blocked inside the sandboxed frame, and
 * sign out. The demo password is read from the local credentials.md and never printed.
 */
import { demoPassword } from "../support/demo-credentials";
import type { Page } from "@playwright/test";

import { expect, test, urls } from "./fixtures";

const OWNER = "owner@demo-family.test";

// Playwright's trace recorder snapshots every frame by injecting script; the message frame's sandbox blocks that and
// Chrome logs "Blocked script execution in 'about:srcdoc'", which would fail the console-error check. That message
// is the sandbox working, not the app: record no trace here so the check stays strict. Screenshots still apply.
test.use({ trace: "off" });

/** On phones the reader replaces the list: go back to it. On wide screens the list is always there. */
async function showList(page: Page) {
  const back = page.getByRole("button", { name: "Back to list" });
  if (await back.isVisible()) await back.click();
}

/** The folder sidebar is a drawer on small screens. */
async function showFolders(page: Page) {
  const open = page.getByRole("button", { name: "Open folders" });
  if (await open.isVisible()) await open.click();
}

test("a wrong mailbox password gets the generic error", async ({ page }) => {
  // Not checking console errors here: the browser logs the expected 401.
  await page.goto(`${urls.webmail}/sign-in?address=${encodeURIComponent(OWNER)}`);
  await expect(page.getByRole("heading", { name: "Sign in to your mailbox" })).toBeVisible();
  await expect(page.getByLabel("Mailbox address")).toHaveValue(OWNER);
  // A native submit (before the page's JavaScript runs) must never put the password in a URL.
  await expect(page.locator("form")).toHaveAttribute("method", "post");
  await page.getByLabel("Password", { exact: true }).fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Mailbox address or password is wrong." })).toBeVisible();
});

test("a person signs in to the webmail, reads mail with remote images blocked, and signs out", async ({
  page,
  consoleErrors,
}) => {
  // Signed out: the webmail origin redirects to its own sign-in form.
  await page.goto(`${urls.webmail}/`);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel("Mailbox address").fill(OWNER);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword(OWNER));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  const list = page.getByRole("listbox", { name: "Inbox messages" });
  await expect(list.getByRole("option", { name: /Your holds are ready for pickup/ })).toBeVisible();

  // An HTML newsletter: its remote images are blocked and it renders in a sandbox without scripts or same-origin.
  await list.getByRole("option", { name: /stories set by the sea/ }).click();
  const reader = page.getByRole("region", { name: "Message" });
  await expect(reader.getByRole("heading", { name: "This month: stories set by the sea" })).toBeVisible();
  await expect(reader.getByRole("status").filter({ hasText: /remote images blocked/ })).toBeVisible();
  const frame = reader.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  // (Not queried inside: the frame runs no script, so test tooling can't either.)
  const srcdoc = (await reader.locator("iframe").getAttribute("srcdoc")) ?? "";
  expect(srcdoc).toContain("This month: stories set by the sea");
  expect(srcdoc).toContain("default-src 'none'");
  expect(srcdoc).not.toMatch(/src="https?:/);

  // A conversation with attachments, offered as downloads.
  await showList(page);
  await list.getByRole("option", { name: /Garden plan for spring/ }).click();
  const attachments = reader.getByRole("list", { name: "Attachments" });
  await expect(attachments.getByRole("link", { name: /garden-plan\.pdf/ })).toHaveAttribute(
    "download",
    "garden-plan.pdf",
  );
  // The name comes from the link, not the URL: the download URL carries only the blob id.
  const pdf = attachments.getByRole("link", { name: /garden-plan\.pdf/ });
  expect(await pdf.getAttribute("href")).toMatch(/^\/api\/webmail\/download\/[A-Za-z0-9_-]+$/);
  const [download] = await Promise.all([page.waitForEvent("download"), pdf.click()]);
  expect(download.suggestedFilename()).toBe("garden-plan.pdf");
  await expect(reader.getByRole("list", { name: "Conversation" }).getByRole("listitem")).toHaveCount(2);

  // Sign out from the folder sidebar (a drawer on small screens).
  await showList(page);
  await showFolders(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to your mailbox" })).toBeVisible();
  // The session is gone server-side too.
  await page.goto(`${urls.webmail}/`);
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(consoleErrors).toEqual([]);
});

test("the console sign-in form posts too, never a GET with the password", async ({ page }) => {
  await page.goto(`${urls.app}/sign-in`);
  await expect(page.locator("form")).toHaveAttribute("method", "post");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

test("keyboard: j and k move through the list, u goes back @desktop-only", async ({ page, consoleErrors }) => {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(OWNER);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword(OWNER));
  await page.getByRole("button", { name: "Sign in" }).click();
  const list = page.getByRole("listbox", { name: "Inbox messages" });
  await expect(list.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("j");
  await expect(list.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Message" })).toBeVisible();
  await page.keyboard.press("j");
  await expect(list.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("u");
  await expect(page.getByText("No message selected")).toBeVisible();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to your mailbox" })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
