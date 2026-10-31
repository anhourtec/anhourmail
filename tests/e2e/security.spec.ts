// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console sign-in security (ADR-0028: the password always first): two-factor sign-in with an authenticator app (codes
 * computed here from the set-up key), recovery codes, passkeys as the second step with a virtual authenticator
 * (Chromium's WebAuthn domain), "Confirm it's you" with the console password, and an Owner requiring two-factor sign-in
 * for everyone in their account. Each browser project uses its own logins (scripts/e2e-fixtures.ts).
 */
import { createHmac } from "node:crypto";

import type { Page } from "@playwright/test";

import { e2eUsers, expect, homeHeading, linkFromMail, signOut, test, urls } from "./fixtures";

/** RFC 6238 code for a base32 key, `steps` 30-second steps from now (the server accepts one step either side). */
function totp(base32Key: string, steps = 0): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32Key.replace(/[\s=]/g, "").toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + steps));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** This browser project's own logins (scripts/e2e-fixtures.ts). */
function logins(project: string) {
  const l = e2eUsers().security[project];
  if (!l) throw new Error(`no security logins for ${project}`);
  return l;
}

async function passwordStep(page: Page, email: string, password: string) {
  await page.goto(`${urls.app}/sign-in`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** A virtual platform authenticator that checks the person (PIN or biometrics) and answers on its own. */
async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** The password step, then the passkey step (the virtual authenticator answers). */
async function signInWithPasskey(page: Page, email: string, password: string) {
  await passwordStep(page, email, password);
  await expect(page.getByRole("heading", { name: "Two-step sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Use your passkey" }).click();
  await expect(homeHeading(page)).toBeVisible();
}

async function openSecurity(page: Page) {
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Security", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Security", level: 1 })).toBeVisible();
}

/** Turns on two-factor sign-in on the Security page; returns the set-up key and the recovery codes shown once. */
async function turnOnTwoFactor(page: Page, password: string): Promise<{ key: string; codes: string[] }> {
  await page.getByRole("button", { name: "Turn on" }).click();
  await page.getByLabel("Confirm your password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("img", { name: "QR code to scan with your authenticator app" })).toBeVisible();
  const key =
    (await page
      .locator("code")
      .filter({ hasText: /^[A-Z2-7 ]{20,}$/ })
      .first()
      .textContent()) ?? "";
  await page.getByLabel(/Enter the 6-digit code/).fill(totp(key));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  const codes = await page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem").allTextContents();
  expect(codes).toHaveLength(10);
  await page.getByRole("button", { name: "I've saved them" }).click();
  await expect(page.getByText("10 of 10 recovery codes left.")).toBeVisible();
  return { key, codes };
}

// Wrong codes answer 401 on purpose, which the browser logs: no console-error assertion here.
test("two-factor sign-in: turn it on, sign in with a code, then with a recovery code", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const u = e2eUsers();
  const email = logins(testInfo.project.name).totp;
  await passwordStep(page, email, u.password);
  await expect(homeHeading(page)).toBeVisible();
  await openSecurity(page);
  const { key, codes } = await turnOnTwoFactor(page, u.password);

  // Sign in again: the password, then a code (the next step's: the one used to turn it on can't be used twice).
  await signOut(page);
  await passwordStep(page, email, u.password);
  await expect(page.getByRole("heading", { name: "Two-step sign-in" })).toBeVisible();
  await page.getByLabel("Code", { exact: true }).fill("000000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That code isn't right" })).toBeVisible();
  await page.getByLabel("Code", { exact: true }).fill(totp(key, 1));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(homeHeading(page)).toBeVisible();

  // And with a recovery code, typed in lower case without dashes.
  await signOut(page);
  await passwordStep(page, email, u.password);
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill((codes[0] ?? "").replace(/-/g, "").toLowerCase());
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(homeHeading(page)).toBeVisible();

  await openSecurity(page);
  await expect(page.getByText("9 of 10 recovery codes left.")).toBeVisible();
  const activity = page.getByRole("list", { name: "Recent sign-in and security activity" });
  await expect(activity.getByText("Recovery code used")).toBeVisible();
  await expect(activity.getByText("With password and recovery code").first()).toBeVisible();
  await expect(activity.getByText("Two-factor sign-in turned on")).toBeVisible();
  // The same recovery code never works twice.
  await signOut(page);
  await passwordStep(page, email, u.password);
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill(codes[0] ?? "");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already used" })).toBeVisible();
});

test("passkeys: add one with a virtual authenticator, rename it, use it as the second step, remove it", async ({
  page,
  consoleErrors,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(consoleErrors).toEqual([]);
  const u = e2eUsers();
  const email = logins(testInfo.project.name).passkey;
  await addVirtualAuthenticator(page);

  // No passwordless passkey sign-in on the page.
  await page.goto(`${urls.app}/sign-in`);
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("button", { name: /passkey/i })).toHaveCount(0);

  await passwordStep(page, email, u.password);
  await expect(homeHeading(page)).toBeVisible();
  await openSecurity(page);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.getByLabel(/^Name/).fill("Test key");
  await page.getByRole("button", { name: "Continue" }).click();
  // A first second factor comes with recovery codes, shown once.
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  const codes = await page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem").allTextContents();
  expect(codes).toHaveLength(10);
  await page.getByRole("button", { name: "I've saved them" }).click();
  await expect(page.getByText("10 of 10 recovery codes left.")).toBeVisible();
  const list = page.getByRole("list", { name: "Your passkeys" });
  await expect(list.getByRole("button", { name: "Rename Test key" })).toBeVisible();

  // The person is told by email (dev mail sink), with a link to their Security page.
  expect(await linkFromMail(page.request, email, /https?:\/\/\S+\/security/)).toMatch(/\/security$/);

  await list.getByRole("button", { name: "Rename Test key" }).click();
  await page.getByLabel("New name for Test key").fill("Laptop key");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(list.getByRole("button", { name: "Rename Laptop key" })).toBeVisible();

  // The password first, then the passkey (a recovery code is the way in without it).
  await signOut(page);
  await passwordStep(page, email, u.password);
  await expect(page.getByRole("heading", { name: "Two-step sign-in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use a recovery code instead" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Lost your passkey? Reset your password" })).toHaveCount(0);
  await page.getByRole("button", { name: "Use your passkey" }).click();
  await expect(homeHeading(page)).toBeVisible();

  // Without the passkey: a recovery code on the second step.
  await signOut(page);
  await passwordStep(page, email, u.password);
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill(codes[0] ?? "");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(homeHeading(page)).toBeVisible();

  await openSecurity(page);
  await expect(
    page
      .getByRole("list", { name: "Recent sign-in and security activity" })
      .getByText("With password and passkey")
      .first(),
  ).toBeVisible();
  await expect(page.getByText("9 of 10 recovery codes left.")).toBeVisible();
  await page.getByRole("button", { name: "Remove Laptop key" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove passkey" }).click();
  await expect(page.getByText("None yet")).toBeVisible();
});

// Requiring what you don't have yet answers 409 on purpose: no console-error assertion here.
test("an Owner requires two-factor sign-in, and a member is sent to set it up first", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const u = e2eUsers();
  const people = logins(testInfo.project.name);

  // The Owner can't require what they don't have yet.
  await passwordStep(page, people.owner, u.password);
  await expect(homeHeading(page)).toBeVisible();
  await openSecurity(page);
  const requirements = page.getByRole("region", { name: "Sign-in requirements" });
  await requirements.getByLabel(/^Two-factor sign-in/).check();
  await requirements.getByRole("button", { name: "Save requirement" }).click();
  await expect(requirements.getByRole("alert").filter({ hasText: "for yourself first" })).toBeVisible();
  await turnOnTwoFactor(page, u.password);
  await requirements.getByLabel(/^Two-factor sign-in/).check();
  await requirements.getByRole("button", { name: "Save requirement" }).click();
  await expect(requirements.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  // The member signs in and lands on their Security page; the console stays closed until they enrol.
  const other = await browser.newContext();
  const member = await other.newPage();
  await passwordStep(member, people.member, u.password);
  await expect(member).toHaveURL(/\/security\?setup=required$/);
  await expect(member.getByText("Set up two-factor sign-in to continue")).toBeVisible();
  await member.goto(`${urls.app}/`);
  await expect(member).toHaveURL(/\/security\?setup=required$/);
  await turnOnTwoFactor(member, u.password);
  // A first factor set up under a requirement is announced to the account's Owners (and the person).
  expect(await linkFromMail(page.request, people.owner, /https?:\/\/\S+\/security/)).toMatch(/\/security$/);
  await member.goto(`${urls.app}/`);
  await expect(homeHeading(member)).toBeVisible();
  await other.close();
});

// Refusals answer 403 on purpose: no console-error assertion here.
test("under a two-factor requirement, a member with only a passkey signs in with the password, then the passkey", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const u = e2eUsers();
  const people = logins(testInfo.project.name);

  // The member adds a passkey (right after signing in, so no extra confirmation is needed).
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await addVirtualAuthenticator(member);
  await passwordStep(member, people.pkMember, u.password);
  await expect(homeHeading(member)).toBeVisible();
  await openSecurity(member);
  await member.getByRole("button", { name: "Add a passkey" }).click();
  await member.getByLabel(/^Name/).fill("Member key");
  await member.getByRole("button", { name: "Continue" }).click();
  await expect(member.getByRole("button", { name: "Rename Member key" })).toBeVisible();
  await signOut(member);

  // The owner turns on two-factor sign-in and requires it.
  await passwordStep(page, people.pkOwner, u.password);
  await expect(homeHeading(page)).toBeVisible();
  await openSecurity(page);
  await turnOnTwoFactor(page, u.password);
  const requirements = page.getByRole("region", { name: "Sign-in requirements" });
  await requirements.getByLabel(/^Two-factor sign-in/).check();
  await requirements.getByRole("button", { name: "Save requirement" }).click();
  await expect(requirements.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  // The password alone gets no session; the passkey step after it does.
  await passwordStep(member, people.pkMember, u.password);
  await expect(member.getByRole("heading", { name: "Two-step sign-in" })).toBeVisible();
  await expect(member).toHaveURL(/\/sign-in$/);
  const me = await member.request.get(`${urls.app}/api/me`);
  expect(me.status()).toBe(401);
  await member.getByRole("button", { name: "Use your passkey" }).click();
  await expect(homeHeading(member)).toBeVisible();
  await memberContext.close();
});

/**
 * Adds a passkey on the Security page. A sign-in or step-up in the last few minutes counts as the confirmation; if it
 * has run out, the console password is asked first. Adding the passkey uses the confirmation up.
 */
async function addPasskey(page: Page, name: string, password: string) {
  await openSecurity(page);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect.poll(async () => (await confirm.isVisible()) || (await page.getByLabel(/^Name/).isVisible())).toBe(true);
  if (await confirm.isVisible()) {
    await confirm.getByLabel("Console password").fill(password);
    await confirm.getByRole("button", { name: "Confirm and continue" }).click();
  }
  await page.getByLabel(/^Name/).fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: `Rename ${name}` })).toBeVisible();
}

/** Opens one of the run's accounts from Platform → Accounts. */
async function openPlatformAccount(page: Page, accountName: string) {
  await page.goto(`${urls.app}/platform/accounts`);
  await page.getByLabel("Search accounts").fill(accountName);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: accountName }).click();
  await expect(page.getByRole("heading", { name: accountName, level: 1 })).toBeVisible();
}

/** "Confirm it's you" must appear (the step-up was used up), and the console password alone answers it. */
async function confirmWithPassword(page: Page, password: string) {
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(confirm).toBeVisible();
  // One field, the password: no code field.
  await expect(confirm.getByRole("textbox")).toHaveCount(1);
  await expect(confirm.getByRole("textbox", { name: "Console password" })).toBeVisible();
  await expect(confirm.getByText(/authenticator app|recovery code/)).toHaveCount(0);
  await confirm.getByLabel("Console password").fill(password);
  await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(confirm).toHaveCount(0);
}

// Regression (2026-10-31): a Global Administrator with a passkey typed the right console password to suspend an account
// and was told to sign in again with the passkey. Adding a passkey uses up the step-up, so the next sensitive action
// asks: the password must just work.
// The step-up refusal answers 403 on purpose (the browser logs it): no console-error assertion here.
test("a Global Administrator with a passkey confirms suspension and support access with the console password", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const u = e2eUsers();
  const { admin, adminAccount } = logins(testInfo.project.name);
  await addVirtualAuthenticator(page);
  await passwordStep(page, admin, u.password);
  await expect(homeHeading(page)).toBeVisible();

  // Suspension.
  await addPasskey(page, "Admin key", u.password);
  await openPlatformAccount(page, adminAccount);
  await page.getByRole("button", { name: "Suspend account", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Suspend this account" });
  await panel.getByLabel("Reason").selectOption({ label: "Sending spam" });
  await panel.getByRole("button", { name: "Suspend account", exact: true }).click();
  await confirmWithPassword(page, u.password);
  await expect(page.getByRole("button", { name: "Lift suspension" }).first()).toBeVisible();
  // Lifting it within the window asks nothing more.
  await page.getByRole("button", { name: "Lift suspension" }).first().click();
  await page
    .getByRole("dialog", { name: "Lift the suspension of this account" })
    .getByRole("button", { name: "Lift suspension", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Suspend account", exact: true })).toBeVisible();

  // Support access. Replacing the passkey (one authenticator holds one per login) uses the step-up up again.
  await openSecurity(page);
  await page.getByRole("button", { name: "Remove Admin key" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove passkey" }).click();
  await expect(page.getByText("None yet")).toBeVisible();
  await addPasskey(page, "Second key", u.password);
  await openPlatformAccount(page, adminAccount);
  await page.getByRole("button", { name: "Open with support access" }).click();
  const open = page.getByRole("dialog", { name: "Open this account with support access" });
  await open.getByLabel("Reason").fill(`${u.run}: checking the step-up`);
  await open.getByRole("button", { name: "Open read-only" }).click();
  await confirmWithPassword(page, u.password);
  const banner = page.getByRole("region", { name: "Support access" });
  await expect(banner).toBeVisible();
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.getByRole("heading", { name: "People", level: 1 })).toBeVisible();
  await banner.getByRole("button", { name: "End support access", exact: true }).click();
  await expect(page.getByRole("heading", { name: adminAccount, level: 1 })).toBeVisible();
  await expect(banner).toHaveCount(0);

  // Signing in again: the password, then the passkey.
  await signOut(page);
  await signInWithPasskey(page, admin, u.password);
});
