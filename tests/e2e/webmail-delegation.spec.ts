// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mailboxes shared with a person, in their webmail (ADR-0026 §6). The Owner gives a member Read and manage and Send as
 * on a shared mailbox (desk@) and Send on behalf on another (team@) in the console. The member's own webmail lists
 * neither (no shared section in the sidebar or the account menu); they send as desk@ and on behalf of team@ from their
 * own mailbox (desk@'s Sent keeps its copy; the message sent on behalf reads "… on behalf of team@"), and read desk@ in
 * a tab of its own (Open another mailbox), which leaves their own tab alone: its sidebar header names desk@ like an
 * account, the tab title names it, and its account menu leads back to their own mailbox. In desk@'s tab, New email
 * and Reply start From desk@ and send as it. An address they have no access to gets the one refusal page. Taking Send
 * as away leaves New email off there, with why; taking Read and manage away closes its tab. A session left on a shared
 * mailbox by the old in-place switch comes back on the person's own. Local delivery only (rule 19).
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
  await write(page, page.getByRole("dialog", { name: "New message" }), to, subject, pickFrom);
}

/** Fills an open composer (From chosen by `pickFrom`, then To and Subject) and sends it. */
async function write(
  page: Page,
  composer: Locator,
  to: string,
  subject: string,
  pickFrom: (from: Locator) => Promise<void>,
) {
  await pickFrom(composer.getByLabel("From"));
  await composer.getByLabel("To", { exact: true }).fill(to);
  await composer.getByLabel("To", { exact: true }).press("Enter");
  await composer.getByLabel("Subject").fill(subject);
  const body = composer.getByRole("textbox", { name: "Message", exact: true });
  await expect(body).toHaveAttribute("contenteditable", "true");
  await body.fill("Sent from the shared desk.");
  await composer.getByRole("button", { name: "Send" }).click();
  // The newest toast (an earlier send's may still be showing).
  await expect(page.getByRole("status").filter({ hasText: "Message sent." }).last()).toBeVisible({
    timeout: SIGN_IN_TIMEOUT,
  });
  await expect(composer).toBeHidden();
}

test("a member reads, sends as and on behalf of mailboxes shared with them, opening one in a tab of its own @desktop-only", async ({
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

  // Neither shared mailbox is listed in the member's own webmail: not in the sidebar, not in the account menu (desk@
  // opens with Open another mailbox; both are offered in From).
  const folders = mail.getByRole("navigation", { name: "Folders" });
  await expect(folders.getByRole("button", { name: "Inbox" })).toBeVisible();
  await expect(folders.getByText(dw.shared)).toHaveCount(0);
  await expect(folders.getByText(dw.team)).toHaveCount(0);
  await expect(mail.getByText("Shared with you")).toHaveCount(0);
  await mail.getByRole("button", { name: "Mailboxes and account" }).click();
  const account = mail.getByRole("menu", { name: "Mailboxes and account" });
  await expect(account.getByRole("menuitemcheckbox", { name: dw.mailbox })).toHaveAttribute("aria-checked", "true");
  await expect(account.getByText(dw.shared)).toHaveCount(0);
  await expect(account.getByRole("menuitem")).toHaveText(["Add another mailbox", "Open another mailbox", "Sign out"]);
  await mail.keyboard.press("Escape");

  // Send as desk@, and on behalf of team@, from the member's own mailbox to themselves.
  await send(mail, dw.mailbox, `As desk ${tag}`, async (from) => {
    await from.selectOption({ label: dw.shared });
  });
  await send(mail, dw.mailbox, `On behalf ${tag}`, async (from) => {
    const value = await from.locator("option", { hasText: `on behalf of ${dw.team}` }).getAttribute("value");
    await from.selectOption(value ?? "");
  });

  // And one to desk@ from their own address, to answer from desk@ later.
  await send(mail, dw.shared, `To desk ${tag}`, async (from) => {
    await from.selectOption({ label: dw.mailbox });
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
  await expect(tab.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await tab.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  // No banner: the sidebar header names desk@ like an account, and so does the tab title.
  await expect(tab.getByRole("region", { name: "Shared mailbox" })).toHaveCount(0);
  await expect(tab.getByText("Shared with you")).toHaveCount(0);
  await expect(tab.getByRole("radio", { name: dw.shared })).toHaveAttribute("aria-checked", "true");
  await expect(tab).toHaveTitle(new RegExp(`^(\\(\\d+\\) )?${dw.shared.replace(/[.]/g, "\\.")} · Inbox$`));
  // Its account menu: desk@ (shown), the way back to the member's own mailbox, and Open another mailbox.
  await tab.getByRole("button", { name: "Mailboxes and account" }).click();
  const tabMenu = tab.getByRole("menu", { name: "Mailboxes and account" });
  await expect(tabMenu.getByRole("menuitemcheckbox", { name: dw.shared })).toHaveAttribute("aria-checked", "true");
  await expect(tabMenu.getByRole("menuitem")).toHaveText(["Your mailbox", "Open another mailbox"]);
  await tab.keyboard.press("Escape");
  // Reading and managing: no Contacts there, New email writes from desk@ (Send as), and its Sent has the copy.
  const tabFolders = tab.getByRole("navigation", { name: "Folders" });
  await expect(tab.getByRole("button", { name: "New email" })).toBeEnabled();
  await expect(tabFolders.getByRole("button", { name: "Contacts" })).toHaveCount(0);
  await tabFolders.getByRole("button", { name: "Sent", exact: true }).click();
  await expect(tab).toHaveURL(/\/sent$/);
  await expect(tab).toHaveTitle(new RegExp(`^(\\(\\d+\\) )?${dw.shared.replace(/[.]/g, "\\.")} · Sent$`));
  await expect(tab.getByRole("option", { name: new RegExp(`As desk ${tag}`) }).first()).toBeVisible();
  // Settings belong to the member's own mailbox.
  await tab.getByRole("button", { name: "Settings" }).click();
  const ownSettings = tab.getByRole("dialog", { name: "Settings" });
  await expect(ownSettings.getByText("belong to your own mailbox")).toBeVisible();
  await expect(ownSettings.getByRole("link", { name: "Go to your mailbox" })).toBeVisible();
  await ownSettings.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(ownSettings).toBeHidden();

  // In desk@'s tab, New email starts From desk@ (Send as); the copy lands in desk@'s Sent.
  await tab.getByRole("button", { name: "New email" }).click();
  const fresh = tab.getByRole("dialog", { name: "New message" });
  await expect(fresh.getByLabel("From")).toHaveValue(`shared:${dw.shared}`);
  await write(tab, fresh, dw.mailbox, `From the desk tab ${tag}`, async () => undefined);
  await expect(async () => {
    await tab.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: "Sent", exact: true }).click();
    await expect(tab.getByRole("option", { name: new RegExp(`From the desk tab ${tag}`) }).first()).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });

  // Reply there, to the message sent to desk@: From desk@ again, and it reaches the member from desk@.
  const toDesk = await openBySearch(tab, `To desk ${tag}`, dw.mailbox);
  await toDesk.getByRole("button", { name: "Reply", exact: true }).first().click();
  const answer = tab.getByRole("dialog", { name: "Reply" });
  await expect(answer.getByLabel("From")).toHaveValue(`shared:${dw.shared}`);
  await answer.getByRole("button", { name: "Send" }).click();
  await expect(tab.getByRole("status").filter({ hasText: "Message sent." }).last()).toBeVisible({
    timeout: SIGN_IN_TIMEOUT,
  });
  await mail.reload();
  await expect(mail.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  const reply = await openBySearch(mail, `To desk ${tag}`, dw.shared);
  await expect(reply.getByRole("heading", { name: `Re: To desk ${tag}` })).toBeVisible();
  await expect(reply.getByText(`<${dw.shared}>`).first()).toBeVisible();

  // A session left on desk@ by the old in-place switch (an older page's request): the member's own tab comes back on
  // their own mailbox, and desk@'s tab keeps showing desk@.
  expect(
    await mail.evaluate(async (address) => {
      const res = await fetch("/api/webmail/mailboxes/delegated", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      return res.status;
    }, dw.shared),
  ).toBe(200);
  await mail.reload();
  await expect(mail.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(mail.getByRole("radio", { name: dw.mailbox })).toHaveAttribute("aria-checked", "true");
  await expect(
    mail.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: "Contacts" }),
  ).toBeVisible();
  await expect(mail).toHaveTitle(/Inbox · AnhourMail$/);
  await tab.reload();
  await expect(tab.getByRole("radio", { name: dw.shared })).toHaveAttribute("aria-checked", "true", {
    timeout: SIGN_IN_TIMEOUT,
  });
  // Your mailbox (the tab's account menu) leads to the member's own webmail.
  await tab.getByRole("button", { name: "Mailboxes and account" }).click();
  await tab
    .getByRole("menu", { name: "Mailboxes and account" })
    .getByRole("menuitem", { name: "Your mailbox" })
    .click();
  await expect(tab.getByRole("radio", { name: dw.mailbox })).toHaveAttribute("aria-checked", "true", {
    timeout: SIGN_IN_TIMEOUT,
  });
  await tab.goto(`${urls.webmail}/mailbox/${dw.shared}`);
  await expect(tab.getByRole("radio", { name: dw.shared })).toHaveAttribute("aria-checked", "true", {
    timeout: SIGN_IN_TIMEOUT,
  });

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

  // The Owner takes Send as away: desk@'s tab still reads it, but New email is off there, saying why.
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("link", { name: dw.shared }).click();
  const details = panel(page, dw.shared);
  await details.getByRole("tab", { name: "Delegation" }).click();
  const sendAs = details.getByRole("region", { name: "Send as" });
  await sendAs.getByRole("button", { name: new RegExp(`^Remove .* from Send as$`) }).click();
  await confirmIfAsked(page, sendAs.getByText("Nobody has this yet."), u.password);
  await tab.reload();
  const off = tab.getByRole("button", { name: "New email" });
  await expect(off).toHaveAttribute("aria-disabled", "true", { timeout: SIGN_IN_TIMEOUT });
  await expect(off).toHaveAccessibleDescription(/can read this mailbox but not send from it/);
  await expect(tab.getByText("Ask an admin for Send as or Send on behalf.")).toBeVisible();

  // Then Read and manage: its tab shows the refusal, and the member's own tab still lists no shared mailbox.
  const readManage = details.getByRole("region", { name: "Read and manage" });
  await readManage.getByRole("button", { name: new RegExp(`^Remove .* from Read and manage$`) }).click();
  await confirmIfAsked(page, readManage.getByText("Nobody has this yet."), u.password);
  await mail.reload();
  await expect(mail.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(mail.getByRole("navigation", { name: "Folders" }).getByText(dw.shared)).toHaveCount(0);
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
