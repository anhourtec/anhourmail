// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Named signatures (docs/internal/05-webmail.md "Signatures"): add two in Settings → Writing (one with an embedded
 * image), choose one as the default for new messages and the other for replies, see each start the right kind of
 * message, switch and remove the signature in the composer, send one with its image (embedded, no remote address),
 * and delete a default (it falls back to none). Everything uses this run's own mailbox, which writes to itself
 * (local delivery only; rule 19).
 */
import type { Locator, Page } from "@playwright/test";

import { e2eUsers, expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

// The message frame's sandbox blocks the trace recorder's injected script (see webmail.spec.ts): no trace here.
test.use({ trace: "off" });

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

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
  await expect(settings(page)).toBeVisible();
  await settings(page)
    .getByRole("tab", { name: /^Writing/ })
    .click();
  await expect(settings(page).getByRole("heading", { name: "Signatures" })).toBeVisible();
  await expect(settings(page).getByRole("button", { name: "Add signature" })).toBeEnabled();
}

async function closeSettings(page: Page) {
  await settings(page).getByRole("button", { name: "Close settings" }).last().click();
  await expect(settings(page)).toBeHidden();
}

/** Adds a signature through the dialog: a name, some text, and optionally an image chosen with Insert image. */
async function addSignature(page: Page, name: string, text: string, image = false) {
  await settings(page).getByRole("button", { name: "Add signature" }).click();
  const dialog = page.getByRole("dialog", { name: "Add signature" });
  await dialog.getByLabel("Name").fill(name);
  const body = dialog.getByRole("textbox", { name: "Signature", exact: true });
  await expect(body).toHaveAttribute("contenteditable", "true");
  await body.click();
  await body.pressSequentially(text);
  if (image) {
    const chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Insert image" }).click();
    await (await chooser).setFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
    await expect(body.locator('img[src^="data:image/png;base64,"]')).toHaveCount(1);
  }
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    settings(page).getByRole("table", { name: "Your signatures" }).getByText(name, { exact: true }),
  ).toBeVisible();
}

async function signatureMenu(page: Page, composer: Locator, item: string) {
  await composer.getByRole("button", { name: "Signature", exact: true }).click();
  await page
    .getByRole("menu", { name: "Signature" })
    .getByRole("menuitemcheckbox", { name: item, exact: true })
    .click();
}

const block = (composer: Locator) =>
  composer.getByRole("textbox", { name: "Message", exact: true }).locator("[data-am-signature]");

test("two signatures, defaults for new mail and replies, switching in the composer, an embedded image, deleting a default @desktop-only", async ({
  page,
  consoleErrors,
}) => {
  test.setTimeout(150_000);
  const me = e2eUsers().recipient;
  const tag = `sig-${Date.now().toString(36)}`;
  await signInWebmail(page, me.address, me.password);

  // Two signatures; the first becomes both defaults; Beta becomes the default for replies.
  await openWriting(page);
  await addSignature(page, "Alpha", `Alpha line ${tag}`);
  await addSignature(page, "Beta", `Beta line ${tag}`, true);
  const panel = settings(page).getByRole("tabpanel");
  const forNew = panel.getByLabel("Default for new messages");
  const forReplies = panel.getByLabel("Default for replies and forwards");
  await expect(forNew.locator("option:checked")).toHaveText("Alpha");
  await forReplies.selectOption({ label: "Beta" });
  await expect(panel.getByText("Default signatures saved.")).toBeVisible();
  await expect(forReplies.locator("option:checked")).toHaveText("Beta");
  await closeSettings(page);

  // A new message starts with Alpha; it switches to Beta (with its image), and to none.
  await page.keyboard.press("c");
  const composer = page.getByRole("dialog", { name: "New message" });
  await expect(block(composer)).toContainText(`Alpha line ${tag}`);
  await signatureMenu(page, composer, "Beta");
  await expect(block(composer)).toContainText(`Beta line ${tag}`);
  await expect(block(composer)).not.toContainText("Alpha line");
  await expect(block(composer).locator('img[src^="data:image/png;base64,"]')).toHaveCount(1);
  await signatureMenu(page, composer, "(No signature)");
  await expect(block(composer)).toHaveText("");

  // Back to Beta, and send it to this mailbox itself.
  await signatureMenu(page, composer, "Beta");
  const field = composer.getByRole("textbox", { name: "Message", exact: true });
  await field.press("Control+Home");
  await field.pressSequentially("Hello there");
  await composer.getByLabel("To", { exact: true }).fill(`${me.address},`);
  await composer.getByLabel("Subject").fill(`Signed ${tag}`);
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible();

  // It arrives with the image embedded in the HTML and nothing remote.
  const box = page.getByRole("searchbox", { name: "Search mail" });
  const results = page.getByRole("listbox", { name: "Search results messages" });
  await expect(async () => {
    await box.fill(`subject:${tag}`);
    await box.press("Enter");
    await expect(results.getByRole("option", { name: new RegExp(`Signed ${tag}`) }).first()).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 40_000 });
  await results
    .getByRole("option", { name: new RegExp(`Signed ${tag}`) })
    .first()
    .click();
  const reader = page.getByRole("region", { name: "Message" });
  await expect(reader.getByRole("heading", { name: `Signed ${tag}` })).toBeVisible();
  await reader.getByRole("button", { name: "More actions" }).click();
  const [original] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("menuitem", { name: "Show original" }).click(),
  ]);
  const sourceBox = original.getByLabel("Message source");
  await expect(sourceBox).toContainText(`Signed ${tag}`);
  const source = ((await sourceBox.textContent()) ?? "").replace(/=\r?\n/g, "");
  await original.close();
  expect(source).toContain("Beta line");
  expect(source).toMatch(/src=3D"data:image\/png;base64,|src="data:image\/png;base64,/);
  expect(source).not.toMatch(/<img[^>]+src=(?:3D)?"https?:/i);
  expect(source).not.toContain("data-am-signature");

  // A reply starts with Beta, the default for replies.
  await reader.getByRole("button", { name: "Reply", exact: true }).first().click();
  const reply = page.getByRole("dialog", { name: "Reply" });
  await expect(block(reply)).toContainText(`Beta line ${tag}`);
  await reply.getByRole("button", { name: "Discard draft" }).click();
  await expect(reply).toBeHidden();

  // Deleting Beta: replies fall back to none; new messages keep Alpha.
  await openWriting(page);
  await settings(page).getByRole("button", { name: "Delete Beta" }).click();
  await page
    .getByRole("dialog", { name: "Delete signature?" })
    .getByRole("button", { name: "Delete signature" })
    .click();
  await expect(panel.getByText("Deleted “Beta”.")).toBeVisible();
  await expect(forReplies.locator("option:checked")).toHaveText("(No signature)");
  await expect(forNew.locator("option:checked")).toHaveText("Alpha");
  await closeSettings(page);
  await reader.getByRole("button", { name: "Reply", exact: true }).first().click();
  const reply2 = page.getByRole("dialog", { name: "Reply" });
  await expect(reply2.getByRole("textbox", { name: "Message", exact: true })).toHaveAttribute(
    "contenteditable",
    "true",
  );
  await expect(block(reply2)).toHaveCount(0);
  await reply2.getByRole("button", { name: "Discard draft" }).click();

  // Tidy up: Alpha too.
  await openWriting(page);
  await settings(page).getByRole("button", { name: "Delete Alpha" }).click();
  await page
    .getByRole("dialog", { name: "Delete signature?" })
    .getByRole("button", { name: "Delete signature" })
    .click();
  await expect(settings(page).getByText("No signatures yet.")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
