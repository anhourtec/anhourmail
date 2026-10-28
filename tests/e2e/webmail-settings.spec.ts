// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail settings (docs/internal/05-webmail.md "Settings"): open the window from the sidebar and with `,`, find a
 * group by searching, change the list density and see the list change, set a signature and see it in the composer,
 * and turn automatic replies on and off. Changes that touch mail flow use this run's own mailbox; the density check
 * uses the demo owner (it has mail) and puts the setting back. Demo passwords are read from credentials.md, never
 * printed.
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

/** Opens settings from the sidebar footer (a drawer below 1024px). */
async function openSettings(page: Page) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings(page)).toBeVisible();
}

/** Picks a group (on phones the groups and the panel are two steps). */
async function group(page: Page, name: string) {
  await settings(page)
    .getByRole("tab", { name: new RegExp(`^${name}`) })
    .click();
  await expect(settings(page).getByRole("tabpanel").getByRole("heading", { name, level: 2 })).toBeVisible();
}

async function closeSettings(page: Page) {
  await settings(page).getByRole("button", { name: "Close settings" }).last().click();
  await expect(settings(page)).toBeHidden();
}

test("settings open from the sidebar and the comma key, and search finds groups by keyword", async ({ page }) => {
  const { recipient } = e2eUsers();
  await signInWebmail(page, recipient.address, recipient.password);
  await openSettings(page);
  const search = settings(page).getByRole("searchbox", { name: "Search settings" });
  await expect(search).toBeFocused();
  await search.fill("out of office");
  await expect(settings(page).getByRole("tab")).toHaveCount(1);
  await expect(settings(page).getByRole("tab", { name: /^Automatic replies/ })).toBeVisible();
  await search.fill("signature");
  await expect(settings(page).getByRole("tab", { name: /^Writing/ })).toBeVisible();
  await search.fill("nothing like this");
  await expect(settings(page).getByText("No settings match")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings(page)).toBeHidden();

  await page.keyboard.press(",");
  await expect(settings(page)).toBeVisible();
  await closeSettings(page);
});

test("density changes the message list at once and is kept", async ({ page }) => {
  await signInWebmail(page, OWNER, demoPassword(OWNER));
  const list = page.getByRole("listbox", { name: "Inbox messages" });
  await expect(list.getByRole("option").first()).toBeVisible();
  const choose = async (density: "Compact" | "Comfortable") => {
    await openSettings(page);
    await group(page, "Appearance");
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/webmail/settings/preferences") && r.ok());
    await settings(page).getByRole("radiogroup", { name: "Density" }).getByRole("radio", { name: density }).click();
    await expect(settings(page).getByRole("radio", { name: density })).toHaveAttribute("aria-checked", "true");
    await saved;
    await closeSettings(page);
    await expect(list).toHaveAttribute("data-density", density.toLowerCase());
    return (await list.getByRole("option").first().boundingBox())?.height ?? 0;
  };
  const comfortable = await choose("Comfortable");
  const compact = await choose("Compact");
  expect(compact).toBeLessThan(comfortable);

  // Saved for this mailbox: still compact after a reload.
  await page.reload();
  await expect(page.getByRole("listbox", { name: "Inbox messages" })).toHaveAttribute("data-density", "compact");

  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await choose("Comfortable");
});

test("a signature set in settings is added to new messages", async ({ page }) => {
  const { recipient } = e2eUsers();
  const signature = `Sam from run ${e2eUsers().run}`;
  await signInWebmail(page, recipient.address, recipient.password);
  await openSettings(page);
  await group(page, "Writing");
  const box = settings(page).getByRole("textbox", { name: /^Signature for/ });
  await box.fill(signature);
  await settings(page).getByRole("button", { name: "Save signature" }).click();
  await expect(settings(page).getByText("Signature saved.")).toBeVisible();
  await closeSettings(page);

  await page.keyboard.press("c");
  const composer = page.getByRole("dialog", { name: "New message" });
  // New messages start in rich text: the signature block sits under an empty line, after the "-- " separator.
  const message = composer.getByRole("textbox", { name: "Message", exact: true });
  await expect(message).toHaveAttribute("contenteditable", "true");
  await expect(message.locator("[data-am-signature]")).toHaveText(`-- ${signature}`);
  await composer.getByRole("button", { name: "Discard draft" }).click();

  // Clear it again.
  await openSettings(page);
  await group(page, "Writing");
  await settings(page)
    .getByRole("textbox", { name: /^Signature for/ })
    .fill("");
  await settings(page).getByRole("button", { name: "Save signature" }).click();
  await expect(settings(page).getByText("Signature saved.")).toBeVisible();
});

test("automatic replies can be turned on and off", async ({ page }) => {
  const { recipient } = e2eUsers();
  await signInWebmail(page, recipient.address, recipient.password);
  await openSettings(page);
  await group(page, "Automatic replies");
  const panel = settings(page).getByRole("tabpanel");
  await panel.getByRole("switch", { name: "Send automatic replies" }).click();
  await panel.getByLabel("Subject (optional)").fill("Away this week");
  await panel.getByLabel("Message").fill("Thanks for writing. I'm away and will reply next week.");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByText("Automatic replies are on.")).toBeVisible();
  await closeSettings(page);

  // Read back from the mail server.
  await openSettings(page);
  await group(page, "Automatic replies");
  const again = settings(page).getByRole("tabpanel");
  await expect(again.getByRole("switch", { name: "Send automatic replies" })).toHaveAttribute("aria-checked", "true");
  await expect(again.getByLabel("Subject (optional)")).toHaveValue("Away this week");
  await again.getByRole("switch", { name: "Send automatic replies" }).click();
  await again.getByRole("button", { name: "Save", exact: true }).click();
  await expect(again.getByText("Automatic replies are off.")).toBeVisible();
});

test("drafts, sending, undo and uploads are refused for a mailbox the tab doesn't show", async ({ page }) => {
  const { recipient } = e2eUsers();
  await signInWebmail(page, recipient.address, recipient.password);
  const draft = {
    identityId: "i1",
    to: [{ email: "x@dev.test" }],
    cc: [],
    bcc: [],
    subject: "x",
    text: "x",
    attachments: [],
  };
  const json = { origin: urls.webmail, "content-type": "application/json" };
  const calls = [
    { method: "PUT", path: "/api/webmail/drafts", headers: json, data: JSON.stringify(draft) },
    {
      method: "POST",
      path: "/api/webmail/send",
      headers: json,
      data: JSON.stringify({ draftId: "d1", identityId: "i1" }),
    },
    { method: "POST", path: "/api/webmail/send/undo", headers: json, data: JSON.stringify({ submissionId: "s1" }) },
    {
      method: "POST",
      path: "/api/webmail/upload",
      headers: { origin: urls.webmail, "content-type": "text/plain" },
      data: "hello",
    },
  ];
  for (const c of calls) {
    // No account header: refused before anything happens.
    const missing = await page.request.fetch(`${urls.webmail}${c.path}`, {
      method: c.method,
      headers: c.headers,
      data: c.data,
    });
    expect(missing.status(), `${c.path} without the header`).toBe(400);
    // Another account than the session's active one (as after a switch in another tab): refused, never applied.
    const other = await page.request.fetch(`${urls.webmail}${c.path}`, {
      method: c.method,
      headers: { ...c.headers, "x-webmail-account": "not-this-account" },
      data: c.data,
    });
    expect(other.status(), `${c.path} for another mailbox`).toBe(400);
    expect(((await other.json()) as { error: { message: string } }).error.message).toBe(
      "Your active mailbox changed. Try again.",
    );
  }
});
