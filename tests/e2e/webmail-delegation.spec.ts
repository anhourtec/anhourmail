// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mailboxes shared with a person, in their webmail (ADR-0026 §6). The Owner gives a member Read and manage and Send as
 * on a shared mailbox (desk@) and Send on behalf on another (team@) in the console. The member then finds desk@ under
 * "Shared with you", sends as it and on behalf of team@ from their own mailbox (desk@'s Sent keeps its copy; the
 * message sent on behalf reads "… on behalf of team@"), reads desk@ in place and in a tab of its own (Open another
 * mailbox), which leaves their own tab alone; an address they have no access to gets the one refusal page. Taking
 * Read and manage away removes desk@ from "Shared with you" and closes its tab. Local delivery only (rule 19).
 */
import type { BrowserContext, Locator, Page } from "@playwright/test";

import { e2eUsers, expect, openNav, panel, SIGN_IN_TIMEOUT, signIn, test, urls } from "./fixtures";

// The message frame's sandbox blocks the trace recorder's injected script (see webmail.spec.ts): no trace here.
test.use({ trace: "off" });

/** Waits for a console change to land; confirms with the console password first if the server asks. */
async function confirmIfAsked(page: Page, done: Locator, password: string, gone = false) {
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  const landed = async () => (gone ? (await done.count()) === 0 : await done.isVisible());
  await expect
    .poll(async () => (await confirm.isVisible()) || (await landed()), { timeout: SIGN_IN_TIMEOUT })
    .toBe(true);
  if (await confirm.isVisible()) {
    await confirm.getByLabel("Console password").fill(password);
    await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  }
  if (gone) await expect(done).toHaveCount(0);
  else await expect(done).toBeVisible();
}

/** Adds the delegate to one of a mailbox's three lists on its Delegation tab. */
async function grant(page: Page, mailbox: string, list: string, delegate: string, password: string) {
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("link", { name: mailbox }).click();
  const details = panel(page, mailbox);
  await details.getByRole("tab", { name: "Delegation" }).click();
  const region = details.getByRole("region", { name: list });
  await region.getByRole("button", { name: `Add people to ${list}` }).click();
  await region.getByRole("checkbox", { name: new RegExp(delegate) }).check();
  await region.getByRole("button", { name: "Add", exact: true }).click();
  await confirmIfAsked(page, region.getByRole("listitem").filter({ hasText: delegate }), password);
  await page.keyboard.press("Escape");
}

/** Signs in to the webmail in a context of its own, failing the test on any console error there. */
async function webmailAs(context: BrowserContext, address: string, password: string) {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  return { page, errors };
}

/**
 * Searches until a message from `from` with `subject` shows up (mail arrives once the undo hold is over; until then
 * the member's own draft of it is still there), then opens it.
 */
async function openBySearch(page: Page, subject: string, from: string) {
  const box = page.getByRole("searchbox", { name: "Search mail" });
  const row = page
    .getByRole("listbox", { name: "Search results messages" })
    .getByRole("option", { name: new RegExp(subject) })
    .first();
  await expect(async () => {
    await box.fill(`from:${from} subject:${subject}`);
    await box.press("Enter");
    await expect(row).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 40_000 });
  await row.click();
  const reader = page.getByRole("region", { name: "Message" });
  await expect(reader.getByRole("heading", { name: subject })).toBeVisible();
  return reader;
}

/** Writes a message to `to` from the chosen From option and sends it. */
async function send(page: Page, to: string, subject: string, pickFrom: (from: Locator) => Promise<void>) {
  await page.getByRole("button", { name: "New email" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await pickFrom(composer.getByLabel("From"));
  await composer.getByLabel("To", { exact: true }).fill(to);
  await composer.getByLabel("To", { exact: true }).press("Enter");
  await composer.getByLabel("Subject").fill(subject);
  const body = composer.getByRole("textbox", { name: "Message", exact: true });
  await expect(body).toHaveAttribute("contenteditable", "true");
  await body.fill("Sent from the shared desk.");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await expect(composer).toBeHidden();
}

test("a member reads, sends as and on behalf of mailboxes shared with them, in place and in a tab of its own @desktop-only", async ({
  page,
  browser,
  consoleErrors,
}, testInfo) => {
  test.setTimeout(240_000);
  const u = e2eUsers();
  const dw = u.delegationWebmail[testInfo.project.name] ?? {
    owner: "",
    delegate: "",
    mailbox: "",
    mailboxPassword: "",
    shared: "",
    team: "",
  };
  const tag = `dw-${Date.now().toString(36)}`;

  // The Owner gives the member Read and manage and Send as on desk@, and Send on behalf on team@.
  await signIn(page, dw.owner, u.password);
  await grant(page, dw.shared, "Read and manage", dw.delegate, u.password);
  await grant(page, dw.shared, "Send as", dw.delegate, u.password);
  await grant(page, dw.team, "Send on behalf", dw.delegate, u.password);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page: mail, errors } = await webmailAs(context, dw.mailbox, dw.mailboxPassword);

  // desk@ shows up by itself under "Shared with you"; team@ (send on behalf only) is offered in From, not there.
  const folders = mail.getByRole("navigation", { name: "Folders" });
  await expect(folders.getByRole("button", { name: dw.shared })).toBeVisible();
  await expect(folders.getByRole("button", { name: dw.team })).toHaveCount(0);

  // Send as desk@, and on behalf of team@, from the member's own mailbox to themselves.
  await send(mail, dw.mailbox, `As desk ${tag}`, async (from) => {
    await from.selectOption({ label: dw.shared });
  });
  await send(mail, dw.mailbox, `On behalf ${tag}`, async (from) => {
    const value = await from.locator("option", { hasText: `on behalf of ${dw.team}` }).getAttribute("value");
    await from.selectOption(value ?? "");
  });

  // In their Inbox: the first comes from desk@ with no sign of them; the second reads "… on behalf of team@".
  const asDesk = await openBySearch(mail, `As desk ${tag}`, dw.shared);
  await expect(asDesk.getByText(`<${dw.shared}>`).first()).toBeVisible();
  await expect(asDesk.getByText(/on behalf of/)).toHaveCount(0);
  const onBehalf = await openBySearch(mail, `On behalf ${tag}`, dw.team);
  await expect(onBehalf.getByText(`<${dw.team}>`).first()).toBeVisible();
  await expect(
    onBehalf.getByText(new RegExp(`^On behalf of .*${dw.team.replace(/[.]/g, "\\.")}.*, sent by `)).first(),
  ).toBeVisible();

  // Open desk@ here: a banner says which mailbox this is, there's nothing to write with, and its Sent has the copy.
  await folders.getByRole("button", { name: dw.shared }).click();
  const banner = mail.getByRole("region", { name: "Shared mailbox" });
  await expect(banner).toContainText(dw.shared);
  await expect(mail.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(mail.getByRole("button", { name: "New email" })).toHaveCount(0);
  await expect(folders.getByRole("button", { name: "Contacts" })).toHaveCount(0);
  await folders.getByRole("button", { name: "Sent", exact: true }).click();
  await expect(mail.getByRole("heading", { name: "Sent", level: 1 })).toBeVisible();
  await expect(mail.getByRole("option", { name: new RegExp(`As desk ${tag}`) }).first()).toBeVisible();
  // Settings belong to the member's own mailbox.
  await mail.getByRole("button", { name: "Settings" }).click();
  const settings = mail.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByText("belong to your own mailbox")).toBeVisible();
  await settings.getByRole("button", { name: "Back to your mailbox" }).click();
  await expect(banner).toHaveCount(0);
  await expect(mail.getByRole("button", { name: "New email" })).toBeVisible();

  // Open another mailbox: desk@ in a tab of its own; this tab keeps the member's own mailbox.
  await mail.getByRole("button", { name: "Mailboxes and account" }).click();
  await mail.getByRole("menuitem", { name: "Open another mailbox" }).click();
  const dialog = mail.getByRole("dialog", { name: "Open another mailbox" });
  await dialog.getByLabel("Mailbox address").fill(dw.shared);
  const [tab] = await Promise.all([context.waitForEvent("page"), dialog.getByRole("button", { name: "Open" }).click()]);
  tab.on("console", (m) => {
    if (m.type() === "error") errors.push(`tab: ${m.text()}`);
  });
  await expect(tab).toHaveURL(new RegExp(`/mailbox/${dw.shared.replace(/[.]/g, "\\.")}$`));
  await expect(tab.getByRole("region", { name: "Shared mailbox" })).toContainText(dw.shared);
  await expect(tab.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await tab.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await tab.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: "Sent", exact: true }).click();
  await expect(tab).toHaveURL(/\/sent$/);
  await expect(tab.getByRole("option", { name: new RegExp(`As desk ${tag}`) }).first()).toBeVisible();
  await mail.reload();
  await expect(mail.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(mail.getByRole("region", { name: "Shared mailbox" })).toHaveCount(0);
  await expect(mail.getByRole("button", { name: "New email" })).toBeVisible();

  // An address they have no access to — another account's, or none at all — gets the one refusal page. Followed from
  // a link on another site, the page asks before opening anything; typed in the address bar, it opens at once. (Its
  // own tab: the browser logs the expected 404.)
  const refused = await context.newPage();
  await refused.setContent(`<a href="${urls.webmail}/mailbox/${u.recipient.address}">a link elsewhere</a>`);
  await refused.getByRole("link", { name: "a link elsewhere" }).click();
  await expect(refused.getByRole("heading", { name: "Open a shared mailbox" })).toBeVisible({
    timeout: SIGN_IN_TIMEOUT,
  });
  await refused.getByRole("button", { name: `Open ${u.recipient.address}` }).click();
  await expect(refused.getByRole("heading", { name: "You don't have access to this mailbox" })).toBeVisible({
    timeout: SIGN_IN_TIMEOUT,
  });
  await expect(refused.getByText(u.recipient.address)).toBeVisible();
  await refused.goto(`${urls.webmail}/mailbox/nobody-${tag}@example.test`);
  await expect(refused.getByRole("heading", { name: "You don't have access to this mailbox" })).toBeVisible({
    timeout: SIGN_IN_TIMEOUT,
  });
  await expect(refused.getByRole("link", { name: "Go to your mailbox" })).toBeVisible();
  await refused.close();

  // The Owner takes Read and manage away: desk@ leaves "Shared with you", and its tab shows the refusal.
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("link", { name: dw.shared }).click();
  const details = panel(page, dw.shared);
  await details.getByRole("tab", { name: "Delegation" }).click();
  const readManage = details.getByRole("region", { name: "Read and manage" });
  await readManage.getByRole("button", { name: new RegExp(`^Remove .* from Read and manage$`) }).click();
  await confirmIfAsked(page, readManage.getByText("Nobody has this yet."), u.password);
  await mail.reload();
  await expect(mail.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(mail.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: dw.shared })).toHaveCount(
    0,
  );
  // A grant still in use is trusted for up to 10 s (the gate's cache; the console says "up to a minute").
  await expect(async () => {
    await tab.reload();
    await expect(tab.getByRole("heading", { name: "You don't have access to this mailbox" })).toBeVisible({
      timeout: 4_000,
    });
  }).toPass({ timeout: 40_000 });

  expect(errors.filter((e) => !e.startsWith("tab: Failed to load resource"))).toEqual([]);
  await context.close();
  expect(consoleErrors).toEqual([]);
});
