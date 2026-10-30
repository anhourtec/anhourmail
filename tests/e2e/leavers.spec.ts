// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A leaver's mailbox: an Owner adds a user, who signs in to the webmail; the Owner removes them from the account. The
 * mailbox stays, belonging to nobody, and the person's way in is closed: their webmail session ends and their
 * password no longer signs in (the mail server gets a new password nobody is shown).
 */
import { e2eUsers, expect, openNav, panel, signIn, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

test.use({ trace: "off" });

test("removing someone keeps their mailbox and turns their sign-in to it off", async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000);
  const u = e2eUsers();
  const fs = u.firstSignIn[testInfo.project.name] ?? { owner: "", domain: "" };
  // Starts with the run id, so the fixture cleanup removes the login it creates.
  const localPart = `${u.run}-leaver${String(testInfo.retry)}`;
  const address = `${localPart}@${fs.domain}`;
  await signIn(page, fs.owner, u.password);

  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("link", { name: "Add a user" }).first().click();
  await page.getByLabel("First name", { exact: true }).fill("Leaver");
  await page.getByLabel("Username", { exact: true }).fill(localPart);
  await page.getByLabel("Domain", { exact: true }).selectOption({ label: fs.domain });
  await page
    .getByLabel("Require this user to change their password when they first sign in", { exact: true })
    .uncheck();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Finish adding" }).click();
  await expect(page.getByRole("heading", { name: "User added", level: 2 })).toBeVisible();
  const given = (await page.getByTestId("generated-password").textContent()) ?? "";

  // The person signs in to their webmail (once the mailbox is on the mail server).
  const person = await browser.newContext({
    // Their own documentation-range client address: the failed sign-in below is counted against it, not the
    // loopback identity the other tests share (CLAUDE.md "Ports and local URLs").
    extraHTTPHeaders: { "X-Forwarded-For": `198.51.100.${String(1 + Math.floor(Math.random() * 254))}` },
  });
  const them = await person.newPage();
  await expect(async () => {
    await them.goto(`${urls.webmail}/sign-in`);
    await them.getByLabel("Mailbox address").fill(address);
    await them.getByLabel("Password", { exact: true }).fill(given);
    await them.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(them.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });

  // The Owner removes them.
  await (await openNav(page)).getByRole("link", { name: "People and roles" }).click();
  await page
    .getByRole("row", { name: new RegExp(address) })
    .getByRole("button", { name: `Actions for ${address}` })
    .click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  const confirm = page.getByRole("alertdialog", { name: `Remove ${address}?` });
  await expect(confirm.getByText("shared addresses with their sign-in turned off")).toBeVisible();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("row", { name: new RegExp(address) })).toHaveCount(0);

  // Their mailbox stays and belongs to nobody.
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("link", { name: address }).click();
  await expect(panel(page, new RegExp(address)).getByText("Nobody yet")).toBeVisible();

  // Their webmail session ends once the new password reaches the mail server, and their password is refused.
  await expect(async () => {
    await them.goto(`${urls.webmail}/`);
    await expect(them.getByRole("heading", { name: "Sign in to your mailbox" })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await them.getByLabel("Mailbox address").fill(address);
  await them.getByLabel("Password", { exact: true }).fill(given);
  await them.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(them.getByRole("alert").filter({ hasText: "Mailbox address or password is wrong." })).toBeVisible({
    timeout: SIGN_IN_TIMEOUT,
  });
  await person.close();
});
