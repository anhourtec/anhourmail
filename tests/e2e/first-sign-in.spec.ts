// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The first-sign-in password change: an Owner adds a user with a generated password and "Require this user to change
 * their password when they first sign in"; the person signs in to the console, is sent to /change-password before
 * anything else, chooses their own password and lands on Home, and the requirement is gone afterwards.
 */
import { e2eUsers, expect, homeHeading, openNav, signIn, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

test.use({ trace: "off" });

test("a user added with a required password change chooses their own at first sign-in", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const u = e2eUsers();
  const fs = u.firstSignIn[testInfo.project.name] ?? { owner: "", domain: "" };
  const localPart = `robin${String(testInfo.retry)}`;
  const address = `${localPart}@${fs.domain}`;
  await signIn(page, fs.owner, u.password);

  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("link", { name: "Add a user" }).first().click();
  await expect(page.getByRole("heading", { name: "Add a user", level: 1 })).toBeVisible();
  await page.getByLabel("First name", { exact: true }).fill("Robin");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Robin");
  await page.getByLabel("Username", { exact: true }).fill(localPart);
  await page.getByLabel("Domain", { exact: true }).selectOption({ label: fs.domain });
  await expect(page.getByLabel("Automatically create a password", { exact: true })).toBeChecked();
  await expect(
    page.getByLabel("Require this user to change their password when they first sign in", { exact: true }),
  ).toBeChecked();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Must be changed at first sign-in.")).toBeVisible();
  await page.getByRole("button", { name: "Finish adding" }).click();
  await expect(page.getByRole("heading", { name: "User added", level: 2 })).toBeVisible();
  const given = (await page.getByTestId("generated-password").textContent()) ?? "";
  expect(given.length).toBeGreaterThanOrEqual(12);

  // The person signs in with the password they were given and is sent to choose their own first.
  const person = await browser.newContext();
  const them = await person.newPage();
  await them.goto(`${urls.app}/sign-in`);
  await them.getByLabel("Email").fill(address);
  await them.getByLabel("Password", { exact: true }).fill(given);
  await them.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(them).toHaveURL(/\/change-password$/, { timeout: SIGN_IN_TIMEOUT });
  await expect(them.getByRole("heading", { name: "Choose your own password", level: 1 })).toBeVisible();
  // Nothing else opens until they do.
  await them.goto(`${urls.app}/security`);
  await expect(them).toHaveURL(/\/change-password$/);

  const chosen = `${u.run} robin's own password`;
  await them.getByLabel("Password you were given", { exact: true }).fill(given);
  await them.getByLabel("New password", { exact: true }).fill(chosen);
  await them.getByLabel("Confirm new password", { exact: true }).fill(chosen);
  await them.getByRole("button", { name: "Save and continue" }).click();
  await expect(homeHeading(them)).toBeVisible({ timeout: SIGN_IN_TIMEOUT });

  // The requirement is gone: the change page sends them home, and the new password signs in.
  await them.goto(`${urls.app}/change-password`);
  await expect(homeHeading(them)).toBeVisible();
  await person.close();
  const fresh = await browser.newContext();
  await signIn(await fresh.newPage(), address, chosen);
  await fresh.close();
});
