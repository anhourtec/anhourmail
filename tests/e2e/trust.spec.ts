// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trust tiers (ADR-0034 §5): a new Free account's Sending card in the console (Owner yes, Member no) and the mail-app
 * notice on App passwords; the webmail's Settings → Account → Sending and a held send that names the outside recipient
 * (worked out in the browser) and sends the rest; staff on Platform → account: the Trust card, Change tier (restricted,
 * then back) and a mailbox's Restrict sending / Lift behind the step-up; the customer seeing sending paused in the
 * console and the composer. Each browser project has its own Free account (scripts/e2e-fixtures.ts).
 */
import type { Page } from "@playwright/test";

import { e2eUsers, expect, SIGN_IN_TIMEOUT, signIn, signOut, test, urls } from "./fixtures";

const OUTSIDE = "someone@example.com";
/** The browser logs a refused request; each expected refusal removes exactly its own line. */
const REFUSED = "Failed to load resource: the server responded with a status of 403";

function trustOf(project: string) {
  const t = e2eUsers().trust[project];
  if (!t) throw new Error(`no trust fixture for ${project}`);
  return t;
}

/** Takes the browser's line for one expected refused request out of the console errors. */
function expectRefusedOnce(errors: string[]) {
  const at = errors.findIndex((e) => e.includes(REFUSED));
  expect(at, "the refused send is logged by the browser").toBeGreaterThanOrEqual(0);
  errors.splice(at, 1);
}

async function signInWebmail(page: Page, address: string, password: string) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
}

/** Settings → Account → the Sending group (the folders are a drawer on phones). */
async function webmailSending(page: Page) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: /^Account/ }).click();
  return { settings, sending: settings.getByRole("region", { name: "Sending" }) };
}

async function closeSettings(page: Page) {
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Close settings" }).last().click();
  await expect(settings).toBeHidden();
}

/** A new message to `to`, sent; returns the composer. */
async function compose(page: Page, to: string[], subject: string) {
  await page.getByRole("button", { name: "New email" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByLabel("To", { exact: true }).fill(`${to.join(", ")},`);
  await composer.getByLabel("Subject").fill(subject);
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  return composer;
}

/** Confirms it's you when the server asks for a fresh step-up (a recent one still counts). */
async function stepUpIfAsked(page: Page, done: () => Promise<boolean>, password: string) {
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect.poll(async () => (await confirm.isVisible()) || (await done()), { timeout: SIGN_IN_TIMEOUT }).toBe(true);
  if (await confirm.isVisible()) {
    await confirm.getByLabel("Console password").fill(password);
    await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  }
}

/** Platform → account → Change tier, as staff, with a note always and a reason when asked. */
async function changeTier(
  page: Page,
  password: string,
  tier: "New" | "Standard" | "Restricted",
  opts: { reason?: string; automatic?: boolean } = {},
) {
  await page.getByRole("button", { name: "Change tier" }).click();
  const dialog = page.getByRole("dialog", { name: "Change the trust tier" });
  await expect(dialog.getByRole("radio", { name: /^Trusted/ })).toBeDisabled();
  await expect(dialog.getByText(/Not available yet/)).toBeVisible();
  await dialog.getByRole("radio", { name: new RegExp(`^${tier}`) }).check();
  if (opts.reason) await dialog.getByLabel("Reason").selectOption({ label: opts.reason });
  await dialog.getByLabel("Internal note").fill(`e2e: ${tier.toLowerCase()} for a ticket`);
  if (opts.automatic) await dialog.getByLabel(/Let automatic promotion and billing/).check();
  await dialog.getByRole("button", { name: tier === "Restricted" ? "Restrict account" : "Change tier" }).click();
  await stepUpIfAsked(page, async () => (await dialog.count()) === 0, password);
  await expect(dialog).toHaveCount(0);
}

test("a new account: the Owner sees the Sending card and the mail-app notice, a Member sees neither", async ({
  page,
}, info) => {
  const u = e2eUsers();
  const t = trustOf(info.project.name);
  await signIn(page, t.owner, u.password);
  const card = page.getByTestId("sending-card");
  await expect(card).toContainText("New");
  await expect(card).toContainText("You can send to addresses hosted on AnhourMail.");
  await expect(card).toContainText("Mail apps can't send yet.");
  await expect(card.getByRole("link", { name: "What new accounts can send" })).toHaveAttribute(
    "href",
    /\/docs\/sending-limits#new-accounts$/,
  );
  // Published limits only: never a date or what promotes it (rule 33).
  await expect(card).not.toContainText(/UTC|since|automatic promotion/i);
  await page.goto(`${urls.app}/accounts/${t.accountId}/app-passwords`);
  await expect(page.getByTestId("mail-app-notice")).toContainText("they can't send yet");
  await signOut(page);

  await signIn(page, t.member, u.password);
  await expect(page.getByTestId("sending-card")).toHaveCount(0);
});

test("the webmail: Settings shows the tier; a held send names the outside recipient and the rest goes", async ({
  page,
  consoleErrors,
}, info) => {
  const t = trustOf(info.project.name);
  await signInWebmail(page, t.mailbox, t.mailboxPassword);
  const { sending } = await webmailSending(page);
  await expect(sending).toContainText("New");
  await expect(sending).toContainText("Forwarding to an address outside AnhourMail waits until then too.");
  await closeSettings(page);

  const composer = await compose(page, [t.mailbox, OUTSIDE], `Held ${Date.now().toString(36)}`);
  const problem = composer.getByTestId("send-problem");
  await expect(problem).toContainText("New accounts can send to addresses hosted on AnhourMail for now.");
  // Named from the draft in the browser: the outside address, never the mailbox's own domain.
  await expect(problem).toContainText(`May be outside AnhourMail: ${OUTSIDE}.`);
  await expect(problem).not.toContainText(t.mailbox);
  await expect(problem.getByRole("link", { name: "What new accounts can send" })).toBeVisible();
  expectRefusedOnce(consoleErrors);

  // Taking the outside address off clears the list; the rest is delivered.
  await composer.getByRole("button", { name: `Remove ${OUTSIDE}` }).click();
  await expect(problem).not.toContainText("May be outside");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
});

test("Trust & Safety restricts the account and a mailbox, the customer sees sending paused, then it's given back", async ({
  page,
  consoleErrors,
}, info) => {
  test.setTimeout(180_000);
  const u = e2eUsers();
  const t = trustOf(info.project.name);
  const account = `${urls.app}/platform/accounts/${t.accountId}`;

  // Support reads the card (with its note) but can't change it.
  await signIn(page, u.users.supportAdmin, u.password);
  await page.goto(account);
  const card = page.getByTestId("staff-trust");
  await expect(card).toContainText("New");
  await expect(card).toContainText("Default for a new account");
  await expect(card.getByText("Internal note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change tier" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restrict sending" })).toHaveCount(0);
  await signOut(page);

  // Trust & Safety restricts the account.
  await signIn(page, u.users.trustSafetyAdmin, u.password);
  await page.goto(account);
  await changeTier(page, u.password, "Restricted", { reason: "Sending spam" });
  await expect(card).toContainText("Restricted");
  await expect(card).toContainText("Set by staff");
  await expect(card).toContainText("Sending spam");
  await expect(card).toContainText("e2e: restricted for a ticket");

  // And one mailbox, then lifts that again.
  await page.getByRole("tab", { name: /^Mailboxes/ }).click();
  const row = page.getByRole("row", { name: new RegExp(t.mailbox.replace(/[.]/g, "\\.")) });
  await row.getByRole("button", { name: "Restrict sending" }).click();
  const restrict = page.getByRole("dialog", { name: "Restrict this mailbox's sending" });
  await restrict.getByLabel("Reason").selectOption({ label: "Abuse of the service" });
  await restrict.getByLabel("Internal note").fill("e2e: one mailbox");
  await restrict.getByRole("button", { name: "Restrict sending" }).click();
  await stepUpIfAsked(page, async () => (await restrict.count()) === 0, u.password);
  await expect(row).toContainText("Abuse of the service");
  await expect(card).toContainText("1 of 1");
  await row.getByRole("button", { name: "Lift restriction" }).click();
  const lift = page.getByRole("dialog", { name: "Lift this mailbox's sending restriction" });
  await lift.getByLabel("Reason").selectOption({ label: "Abuse of the service" });
  await lift.getByLabel("Internal note").fill("e2e: lifted");
  await lift.getByRole("button", { name: "Lift restriction" }).click();
  await stepUpIfAsked(page, async () => (await lift.count()) === 0, u.password);
  await expect(row.getByRole("button", { name: "Restrict sending" })).toBeVisible();
  await signOut(page);

  // The Owner sees it paused with the reason and where to appeal, never the note.
  await signIn(page, t.owner, u.password);
  const sendingCard = page.getByTestId("sending-card");
  await expect(sendingCard).toContainText("Restricted");
  await expect(sendingCard).toContainText("Reason: Sending spam.");
  await expect(sendingCard).toContainText("support@anhourtec.com");
  await expect(page.getByText("e2e: restricted for a ticket")).toHaveCount(0);
  await signOut(page);

  // The webmail refuses to send and says where to appeal.
  await signInWebmail(page, t.mailbox, t.mailboxPassword);
  const { sending } = await webmailSending(page);
  await expect(sending).toContainText("Forwarding and automatic replies are paused too.");
  await closeSettings(page);
  const composer = await compose(page, [t.mailbox], "Paused");
  const problem = composer.getByTestId("send-problem");
  await expect(problem).toContainText("Sending is paused for this mailbox.");
  await expect(problem.getByRole("link", { name: "support@anhourtec.com" })).toBeVisible();
  expectRefusedOnce(consoleErrors);

  // Trust & Safety gives it back to New, for the automatic promotion to move again.
  await signIn(page, u.users.trustSafetyAdmin, u.password);
  await page.goto(account);
  await changeTier(page, u.password, "New", { reason: "Sending spam", automatic: true });
  await expect(card).toContainText("Automatic (promotion job)");
  await expect(card.getByText("New", { exact: true })).toBeVisible();
});
