// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console sign-in security: two-factor sign-in with an authenticator app (codes computed here from the set-up key),
 * recovery codes, passkeys with a virtual authenticator (Chromium's WebAuthn domain), and an Owner requiring
 * two-factor sign-in for everyone in their account. Each browser project uses its own logins (scripts/e2e-fixtures.ts).
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

test("passkeys: add one with a virtual authenticator, rename it, sign in with it, remove it", async ({
  page,
  consoleErrors,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(consoleErrors).toEqual([]);
  const u = e2eUsers();
  const email = logins(testInfo.project.name).passkey;
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

  await passwordStep(page, email, u.password);
  await expect(homeHeading(page)).toBeVisible();
  await openSecurity(page);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.getByLabel(/^Name/).fill("Test key");
  await page.getByRole("button", { name: "Continue" }).click();
  const list = page.getByRole("list", { name: "Your passkeys" });
  await expect(list.getByRole("button", { name: "Rename Test key" })).toBeVisible();

  // The person is told by email (dev mail sink), with a link to their Security page.
  expect(await linkFromMail(page.request, email, /https?:\/\/\S+\/security/)).toMatch(/\/security$/);

  await list.getByRole("button", { name: "Rename Test key" }).click();
  await page.getByLabel("New name for Test key").fill("Laptop key");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(list.getByRole("button", { name: "Rename Laptop key" })).toBeVisible();

  await signOut(page);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(homeHeading(page)).toBeVisible();

  await openSecurity(page);
  await expect(
    page.getByRole("list", { name: "Recent sign-in and security activity" }).getByText("With passkey").first(),
  ).toBeVisible();
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
test("under a two-factor requirement, a member with only a passkey can't sign in with the password alone", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const u = e2eUsers();
  const people = logins(testInfo.project.name);

  // The member adds a passkey (right after signing in, so no extra confirmation is needed).
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  const cdp = await memberContext.newCDPSession(member);
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

  // The password alone gets no session; the passkey does.
  await passwordStep(member, people.pkMember, u.password);
  await expect(
    member.getByRole("alert").filter({ hasText: "Sign in with your passkey or set up an authenticator app" }),
  ).toBeVisible();
  await expect(member).toHaveURL(/\/sign-in$/);
  const me = await member.request.get(`${urls.app}/api/me`);
  expect(me.status()).toBe(401);
  await member.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(homeHeading(member)).toBeVisible();
  await memberContext.close();
});
