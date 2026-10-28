// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail (Phase 4): sign in with a mailbox address and password on the webmail origin, read the seeded demo mail
 * (`npm run db:seed -- --demo`) with remote images blocked inside the sandboxed frame, write and send mail between
 * two demo mailboxes (local delivery only; rule 19), reply, search, pin, archive with undo, delete, and add and
 * switch mailboxes. Demo passwords are read from the local credentials.md and never printed.
 */
import { demoPassword } from "../support/demo-credentials";
import type { Page } from "@playwright/test";

import { e2eUsers, expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

const OWNER = "owner@demo-family.test";
/**
 * The run's own second mailbox (tests/e2e fixtures): the mail server throttles mail per sender domain and recipient,
 * so journeys that send don't share one demo recipient's hourly allowance across runs.
 */
const recipient = () => e2eUsers().recipient;

// Playwright's trace recorder snapshots every frame by injecting script; the message frame's sandbox blocks that and
// Chrome logs "Blocked script execution in 'about:srcdoc'", which would fail the console-error check. That message
// is the sandbox working, not the app: record no trace here so the check stays strict. Screenshots still apply.
test.use({ trace: "off" });

/** On phones the reader replaces the list: go back to it. On wide screens the list is always there. */
async function showList(page: Page) {
  const list = page.getByRole("listbox").first();
  if (!(await list.isVisible())) await page.getByRole("button", { name: "Close message" }).click();
}

/** The folder sidebar is a drawer below 1024px. */
async function showFolders(page: Page) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
}

/** On phones a contact replaces the contact list: go back to it. */
async function backToContacts(page: Page) {
  const back = page.getByRole("button", { name: "Back to contacts" });
  if (await back.isVisible()) await back.click();
}

/** The Next.js dev indicator (dev builds only) sits over the phone action bar's corner: hide it in tests. */
async function hideDevOverlay(page: Page) {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

async function signInWebmail(page: Page, address: string) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword(address));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await hideDevOverlay(page);
}

/** Searches (from the search box) until a conversation with `text` shows up; mail takes a few seconds to arrive. */
async function findBySearch(page: Page, query: string, text: string) {
  const box = page.getByRole("searchbox", { name: "Search mail" });
  await expect(async () => {
    await box.fill(query);
    await box.press("Enter");
    await expect(
      page
        .getByRole("listbox", { name: "Search results messages" })
        .getByRole("option", { name: new RegExp(text) })
        .first(),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 40_000 });
}

test("a person staff suspended can't use the webmail and is told how to appeal", async ({ page }) => {
  // Not checking console errors here: the browser logs the expected 401.
  const SUSPENDED = "suspended@demo-group.test";
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(SUSPENDED);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword(SUSPENDED));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Your AnhourMail sign-in is suspended" });
  await expect(alert).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await expect(alert).toContainText(/support@anhourtec\.com/);
  await expect(page.getByRole("heading", { name: "Sign in to your mailbox" })).toBeVisible();
});

test.describe("deliberate wrong passwords", () => {
  // Their own client address from the documentation range (RFC 5737), random per run: the dev forwarder passes a
  // loopback client's address through, so the mail server counts (and may ban) this address — never the shared
  // loopback identity every other test signs in from, nor the forwarder.
  test.use({
    extraHTTPHeaders: { "X-Forwarded-For": `203.0.113.${String(1 + Math.floor(Math.random() * 254))}` },
  });

  test("a wrong mailbox password gets the generic error", async ({ page }) => {
    // Not checking console errors here: the browser logs the expected 401.
    // An address in the URL is ignored: pre-filled sign-in links look like phishing links to browsers.
    await page.goto(`${urls.webmail}/sign-in?address=${encodeURIComponent(OWNER)}`);
    await expect(page.getByRole("heading", { name: "Sign in to your mailbox" })).toBeVisible();
    await expect(page.getByLabel("Mailbox address")).toHaveValue("");
    await page.getByLabel("Mailbox address").fill(OWNER);
    // A native submit (before the page's JavaScript runs) must never put the password in a URL.
    await expect(page.locator("form")).toHaveAttribute("method", "post");
    await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Mailbox address or password is wrong." })).toBeVisible({
      timeout: SIGN_IN_TIMEOUT,
    });
  });
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
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
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
  await expect(reader.getByRole("list", { name: "Conversation" }).locator(":scope > li")).toHaveCount(2);

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
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
});

test("keyboard: j and k move through the list, u goes back @desktop-only", async ({ page, consoleErrors }) => {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(OWNER);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword(OWNER));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
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

test("write, send, receive in a second mailbox, reply, search and switch back @desktop-only", async ({
  page,
  consoleErrors,
}) => {
  test.setTimeout(120_000);
  const tag = `e2e-${Date.now().toString(36)}`;
  await signInWebmail(page, OWNER);

  // Compose to another demo mailbox (local delivery only).
  await page.getByRole("button", { name: "New email" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  const MEMBER = recipient().address;
  await composer.getByLabel("To", { exact: true }).fill(MEMBER);
  await composer.getByLabel("To", { exact: true }).press("Enter");
  await expect(composer.getByRole("button", { name: `Remove ${MEMBER}` })).toBeVisible();
  await composer.getByLabel("Subject").fill(`Plans ${tag}`);
  await composer.getByLabel("Message", { exact: true }).fill("Are we still on for Saturday?");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible();
  await expect(composer).toBeHidden();

  // Add the second mailbox to the same session and read it there.
  await page.getByRole("button", { name: "Mailboxes and account" }).click();
  await page.getByRole("menuitem", { name: "Add another mailbox" }).click();
  const add = page.getByRole("dialog", { name: "Add another mailbox" });
  await add.getByLabel("Mailbox address").fill(MEMBER);
  await add.getByLabel("Password", { exact: true }).fill(recipient().password);
  await add.getByRole("button", { name: "Add mailbox" }).click();
  await expect(page.getByRole("radio", { name: MEMBER })).toHaveAttribute("aria-checked", "true");
  await findBySearch(page, `subject:${tag}`, `Plans ${tag}`);
  await page
    .getByRole("listbox", { name: "Search results messages" })
    .getByRole("option", { name: new RegExp(`Plans ${tag}`) })
    .click();
  const reader = page.getByRole("region", { name: "Message" });
  await expect(reader.getByRole("heading", { name: `Plans ${tag}` })).toBeVisible();

  // Reply from the inline box.
  await reader
    .getByRole("group", { name: /^Answer / })
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  const reply = page.getByRole("dialog", { name: "Reply" });
  await expect(reply.getByRole("button", { name: `Remove ${OWNER}` })).toBeVisible();
  await expect(reply.getByLabel("Subject")).toHaveValue(`Re: Plans ${tag}`);
  await reply.getByLabel("Message", { exact: true }).press("Home");
  await reply.getByLabel("Message", { exact: true }).pressSequentially("Yes, see you at 10.");
  await reply.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible();

  // Back to the first mailbox: the reply arrives in the same conversation.
  await page.getByRole("radio", { name: OWNER }).click();
  await expect(page.getByRole("radio", { name: OWNER })).toHaveAttribute("aria-checked", "true");
  await findBySearch(page, `subject:${tag}`, `Re: Plans ${tag}`);
  await page
    .getByRole("listbox", { name: "Search results messages" })
    .getByRole("option", { name: new RegExp(`Re: Plans ${tag}`) })
    .click();
  await expect(reader.getByRole("list", { name: "Conversation" }).locator(":scope > li")).toHaveCount(2);
  // The rich reply quoted the original as a citation, which the reader folds behind a toggle.
  await expect(reader.locator("iframe").last().contentFrame().locator("details[data-am-quote]")).toHaveCount(1);

  // Pin it, see it in Inbox's Pinned section, archive with undo, then delete it for good from Trash. The shortcut
  // acts on the open message, so wait until the reader has it.
  await expect(reader.getByRole("button", { name: "Pin" })).toBeVisible();
  await page.keyboard.press("p");
  await expect(reader.getByRole("button", { name: "Unpin" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search mail" }).fill("");
  await page.getByRole("searchbox", { name: "Search mail" }).press("Escape");
  const inbox = page.getByRole("listbox", { name: "Inbox messages" });
  await expect(inbox.getByText(/^Pinned \(\d+\)$/)).toBeVisible();
  const row = inbox.getByRole("option", { name: new RegExp(`Pinned\\..*Re: Plans ${tag}`) });
  await row.click();
  await reader.getByRole("button", { name: "Unpin" }).click();
  await reader.getByRole("button", { name: "Archive" }).click();
  await expect(inbox.getByRole("option", { name: new RegExp(`Re: Plans ${tag}`) })).toHaveCount(0);
  await page.getByRole("status").filter({ hasText: "Archived." }).getByRole("button", { name: "Undo" }).click();
  await expect(inbox.getByRole("option", { name: new RegExp(`Re: Plans ${tag}`) })).toBeVisible({ timeout: 15_000 });
  await inbox.getByRole("option", { name: new RegExp(`Re: Plans ${tag}`) }).click();
  await reader.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Moved to Trash." })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Folders" })
    .getByRole("button", { name: /^Trash/ })
    .click();
  const trash = page.getByRole("listbox", { name: "Trash messages" });
  await trash
    .getByRole("option", { name: new RegExp(`Plans ${tag}`) })
    .first()
    .click();
  await reader.getByRole("button", { name: "Delete forever" }).click();
  const confirm = page.getByRole("dialog", { name: /Delete this conversation forever/ });
  await confirm.getByRole("button", { name: "Delete forever" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Deleted forever." })).toBeVisible();

  // The new shortcuts are listed in the help dialog.
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help.getByText("Reply / reply all / forward")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(consoleErrors).toEqual([]);
});

/** On a phone the composer covers the screen; on a computer it is a panel beside the mail. */
async function expectComposerLayout(page: Page, composer: ReturnType<Page["getByRole"]>) {
  const box = await composer.boundingBox();
  const viewport = page.viewportSize();
  if (viewport && viewport.width < 768) expect(box?.width).toBe(viewport.width);
  else expect(box?.width).toBeLessThan(viewport?.width ?? 0);
}

test("the composer fits the screen (full screen on phones) and sends", async ({ page, consoleErrors }) => {
  const tag = `m-${Date.now().toString(36)}`;
  await signInWebmail(page, OWNER);
  // New email is in the sidebar on wide screens and floats over the list on phones (no drawer needed).
  await expect(page.getByRole("button", { name: "New email" })).toHaveCount(1);
  await page.getByRole("button", { name: "New email" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await expectComposerLayout(page, composer);
  await composer.getByLabel("To", { exact: true }).fill(`${recipient().address},`);
  await composer.getByLabel("Subject").fill(`Phone ${tag}`);
  await composer.getByLabel("Message", { exact: true }).fill("Sent from the composer test.");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

/** Opens a message found by search (search results are always in view, unlike rows of a long list). */
async function openBySearch(page: Page, query: string, subject: RegExp) {
  await findBySearch(page, query, subject.source);
  await page
    .getByRole("listbox", { name: "Search results messages" })
    .getByRole("option", { name: subject })
    .first()
    .click();
  return page.getByRole("region", { name: "Message" });
}

test("every common body type reads natively in the reader's flow", async ({ page, consoleErrors }) => {
  test.setTimeout(90_000);
  await signInWebmail(page, OWNER);

  // Plain text (format=flowed): joined lines, live links, a collapsed quote, a dimmed signature.
  let reader = await openBySearch(page, 'subject:"Potluck after the run"', /Potluck after the run/);
  await expect(reader.getByText(/I'll bring the folding chairs and a big salad, and I can pick up ice/)).toBeVisible();
  const link = reader.getByRole("link", { name: "https://coastal-trail.example/routes/bluffs" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(reader.getByText("Who's bringing chairs?")).toBeHidden();
  await reader.getByRole("button", { name: "Show quoted text" }).click();
  await expect(reader.getByText(/Who's bringing chairs\?/)).toBeVisible();
  await expect(reader.getByText("Coastal Trail Runners · Sundays at 8")).toBeVisible();

  // Markdown: structure, and HTML in it shown as text, never run.
  await showList(page);
  reader = await openBySearch(page, 'subject:"Cabin weekend checklist"', /Cabin weekend checklist/);
  await expect(reader.getByRole("heading", { name: "Gear" })).toBeVisible();
  await expect(reader.getByRole("listitem").filter({ hasText: /^Camp stove and fuel$/ })).toBeVisible();
  await expect(reader.getByText("<script>alert('markdown can carry HTML; it must never run')</script>")).toBeVisible();

  // A calendar invitation as an event card.
  await showList(page);
  reader = await openBySearch(page, 'subject:"Elm Street block party"', /Invitation: Elm Street block party/);
  const event = reader.getByRole("region", { name: "Event: Elm Street block party" });
  await expect(event.getByText("Community hall, 12 Elm Street")).toBeVisible();

  // A forwarded message opens as a nested, sanitised message.
  await showList(page);
  reader = await openBySearch(
    page,
    'subject:"Members evening moved to Friday"',
    /Fwd: Members' evening moved to Friday/,
  );
  await reader.getByRole("button", { name: "Open Members evening moved to Friday.eml" }).click();
  const nested = page.getByRole("dialog", { name: "Members evening moved to Friday.eml" });
  await expect(nested.getByText("Members' evening moved to Friday")).toBeVisible();
  await expect(nested.getByRole("status").filter({ hasText: "1 remote image blocked" })).toBeVisible();
  await expect(nested.locator("iframe")).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  await nested.getByRole("button", { name: "Close" }).last().click();

  // An image attachment previews inline; a non-UTF-8 message decodes.
  await showList(page);
  reader = await openBySearch(page, 'subject:"Sunset from the dock"', /Sunset from the dock/);
  await reader.getByRole("button", { name: "Preview dock-sunset.png" }).click();
  const viewer = page.getByRole("dialog", { name: "dock-sunset.png" });
  await expect(viewer.getByRole("img", { name: "dock-sunset.png" })).toBeVisible();
  await viewer.getByRole("button", { name: "Close" }).last().click();
  await showList(page);
  reader = await openBySearch(page, "subject:samedi", /Le marché de samedi/);
  await expect(reader.getByText(/Le café du marché ouvre à 7 h/)).toBeVisible();

  // Show original opens its own page in a new tab: a summary, then the source as plain text.
  await reader.getByRole("button", { name: "More actions" }).click();
  const [original] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("menuitem", { name: "Show original" }).click(),
  ]);
  await expect(original.getByRole("heading", { name: "Original message" })).toBeVisible();
  await expect(original.getByLabel("Message source")).toContainText("Message-ID: <sample-latin1@demo-family.test>");
  await expect(original.getByRole("link", { name: "Download original" })).toBeVisible();
  await original.close();
  expect(consoleErrors).toEqual([]);
});

test("ticking a row selects it with a visible checkbox; the print view is sandboxed", async ({ page }) => {
  await signInWebmail(page, OWNER);
  const row = page.getByRole("listbox", { name: "Inbox messages" }).getByRole("option").first();
  await row.hover();
  const box = row.getByRole("checkbox");
  await box.click();
  await expect(box).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("toolbar", { name: "Selected conversations" }).getByText("1 selected")).toBeVisible();
  // The avatar square shows a real checkbox (ticked) while the row is selected, not a blank tile.
  await expect(box.locator("svg")).toBeVisible();
  await page.keyboard.press("Escape");

  // Print opens a printable page served with a sandboxing CSP (an opaque origin, no scripts).
  const reader = await openBySearch(page, "subject:samedi", /Le marché de samedi/);
  await reader.getByRole("button", { name: "More actions" }).click();
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("menuitem", { name: "Print" }).click(),
  ]);
  await popup.waitForLoadState();
  await expect(popup.getByRole("heading", { name: "Le marché de samedi" })).toBeVisible();
  const res = await page.request.get(popup.url());
  expect(res.headers()["content-security-policy"]).toContain("sandbox");
  expect(res.headers()["content-security-policy"]).toContain("default-src 'none'");
  await popup.close();
});

test("contacts: browse, search, add, edit and delete a contact; Other contacts holds people you emailed", async ({
  page,
  consoleErrors,
}) => {
  const tag = Math.random().toString(36).slice(2, 8);
  await signInWebmail(page, OWNER);
  await showFolders(page);
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: "Contacts" }).click();
  await expect(page.getByRole("heading", { name: "Contacts", level: 1 })).toBeVisible();
  const list = page.getByRole("list", { name: "Contact list" });
  await expect(list.getByRole("button", { name: /Maya Chen/ })).toBeVisible();

  // Search narrows the A–Z list; a contact opens in the detail pane (the only pane on phones).
  await page.getByRole("searchbox", { name: "Search contacts" }).fill("piano");
  await expect(list.getByRole("button", { name: /Maya Chen/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /Jordan Lee/ })).toHaveCount(0);
  await list.getByRole("button", { name: /Maya Chen/ }).click();
  const detail = page.getByRole("region", { name: "Contact: Maya Chen" });
  await expect(detail.getByRole("button", { name: "maya@piano-studio.example" })).toBeVisible();
  await expect(detail.getByText("Chen Piano Studio")).toBeVisible();
  await backToContacts(page);
  await page.getByRole("searchbox", { name: "Search contacts" }).fill("");

  // Other contacts: people saved when you emailed them.
  await page
    .getByRole("group", { name: "Contact groups" })
    .getByRole("button", { name: /Other contacts/ })
    .click();
  await expect(list.getByRole("button", { name: /Riley Morgan/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /Maya Chen/ })).toHaveCount(0);
  await page.getByRole("group", { name: "Contact groups" }).getByRole("button", { name: /^All/ }).click();

  // Add, edit, delete (two steps).
  await page.getByRole("button", { name: "New contact" }).first().click();
  const form = page.getByRole("form", { name: "New contact" });
  await form.getByLabel("First name").fill("Test");
  await form.getByLabel("Last name").fill(`Person ${tag}`);
  await form.getByLabel("Email 1", { exact: true }).fill(`test-${tag}@example.org`);
  await form.getByRole("button", { name: "Save" }).click();
  const mine = page.getByRole("region", { name: `Contact: Test Person ${tag}` });
  await expect(mine.getByRole("button", { name: `test-${tag}@example.org` })).toBeVisible();
  await mine.getByRole("button", { name: "Edit contact" }).click();
  await page.getByRole("form", { name: "Edit contact" }).getByLabel("Company").fill("Test Co");
  await page.getByRole("form", { name: "Edit contact" }).getByRole("button", { name: "Save" }).click();
  await expect(mine.getByText("Test Co")).toBeVisible();
  await mine.getByRole("button", { name: "Delete contact" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: new RegExp(`Test Person ${tag}`) })).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("toolbar buttons show a styled tooltip with the shortcut soon after hover @desktop-only", async ({
  page,
  consoleErrors,
}) => {
  await signInWebmail(page, OWNER);
  await page
    .getByRole("listbox", { name: "Inbox messages" })
    .getByRole("option", { name: /Your holds are ready for pickup/ })
    .click();
  const pin = page.getByRole("region", { name: "Message" }).getByRole("button", { name: /^(Pin|Unpin)$/ });
  await expect(pin).not.toHaveAttribute("title");
  await pin.hover();
  const tip = page.getByRole("tooltip");
  // Shown after the short delay (150 ms), not the browser's slow native tooltip.
  await expect(tip).toBeVisible({ timeout: 600 });
  await expect(tip).toContainText(/Pin|Unpin/);
  await expect(tip.locator("kbd")).toHaveText("p");
  const describedBy = (await pin.getAttribute("aria-describedby")) ?? "";
  expect(describedBy).toContain((await tip.getAttribute("id")) ?? "missing");
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("add a sender to contacts from the reader", async ({ page, consoleErrors }) => {
  await signInWebmail(page, OWNER);
  await page
    .getByRole("listbox", { name: "Inbox messages" })
    .getByRole("option", { name: /Your holds are ready for pickup/ })
    .click();
  const reader = page.getByRole("region", { name: "Message" });
  await reader.getByRole("button", { name: "Add to contacts" }).click();
  await expect(page.getByRole("status").filter({ hasText: "added to contacts" })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Add to contacts" })).toHaveCount(0);

  // Tidy up: delete it from Contacts.
  await showList(page);
  await showFolders(page);
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: "Contacts" }).click();
  await page.getByRole("searchbox", { name: "Search contacts" }).fill("notices@westside");
  await page
    .getByRole("list", { name: "Contact list" })
    .getByRole("button", { name: /Westside Library/ })
    .click();
  await page.getByRole("button", { name: "Delete contact" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("list", { name: "Contact list" })).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});
