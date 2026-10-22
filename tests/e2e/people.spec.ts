// SPDX-License-Identifier: AGPL-3.0-only
/** People and roles: invites delivered to the dev mail sink, accepting them, role changes and the guard rails. */
import {
  e2eUsers,
  expect,
  homeHeading,
  linkFromMail,
  openNav,
  panel,
  panelReady,
  signIn,
  test,
  urls,
} from "./fixtures";

test("an owner invites someone who creates a login from the email, then changes their role and removes them", async ({
  page,
  browser,
}, testInfo) => {
  // The duplicate-invite check answers 409 on purpose, which the browser logs; so no console-error assertion here.
  test.setTimeout(90_000);
  const u = e2eUsers();
  const invitee = `${u.run}-${testInfo.project.name}-invitee@e2e.test`;
  await signIn(page, u.users.owner, u.password);
  await (await openNav(page)).getByRole("link", { name: "People and roles" }).click();
  await expect(page.getByRole("heading", { name: "People and roles", level: 1 })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(u.users.owner) }).getByText("You")).toBeVisible();

  await page.getByRole("link", { name: "Invite someone" }).click();
  const inviting = panel(page, "Invite someone");
  await page.getByLabel("Email").fill(invitee);
  await page.getByLabel("Role", { exact: true }).selectOption({ label: "Read-only (Auditor)" });
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Invite sent to ${invitee}` })).toBeVisible();
  const pending = page.getByRole("row", { name: new RegExp(invitee) });
  await expect(pending.getByText("Pending")).toBeVisible();

  // Inviting the same address again is refused.
  await page.getByLabel("Email").fill(invitee);
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already has an invite" })).toBeVisible();
  await inviting.getByRole("link", { name: "Close" }).click();

  // The invitee opens the emailed link, signed out, and creates their login.
  const link = await linkFromMail(page.request, invitee, /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]{43}/);
  const other = await browser.newContext();
  const guest = await other.newPage();
  await guest.goto(link);
  await expect(guest.getByRole("heading", { name: `Join ${u.accountName}` })).toBeVisible();
  await expect(guest.getByText(invitee)).toBeVisible();
  await guest.getByLabel("First name").fill("Invited");
  await guest.getByLabel(/Last name/).fill("Person");
  await guest.getByLabel("Password", { exact: true }).fill(`${u.password}-invitee`);
  await guest.getByLabel("Confirm password").fill(`${u.password}-invitee`);
  await guest.getByRole("button", { name: "Create login and join" }).click();
  await expect(homeHeading(guest)).toBeVisible();
  await expect(guest.getByRole("heading", { name: u.accountName })).toBeVisible();
  // The link is used up.
  await guest.goto(link);
  await expect(guest.getByRole("alert").filter({ hasText: "expired, been used or been revoked" })).toBeVisible();
  await other.close();

  // Back as the owner: they're a member now, as an Auditor; promote them from their panel, then remove them.
  await page.reload();
  const row = page.getByRole("row", { name: new RegExp(invitee) });
  await expect(row.getByRole("cell", { name: "Read-only (Auditor)", exact: true })).toBeVisible();
  await row.getByRole("button", { name: `Actions for ${invitee}` }).click();
  await page.getByRole("menuitem", { name: "Change role" }).click();
  const person = panel(page, /Invited Person/);
  await expect(person.getByRole("tab", { name: "Role" })).toHaveAttribute("aria-selected", "true");
  await expect(person.getByLabel(`Role for ${invitee}`)).toHaveValue("auditor");
  await person.getByLabel(`Role for ${invitee}`).selectOption({ label: "User Administrator" });
  await person.getByRole("button", { name: "Save role" }).click();
  // The Role column follows once the page has refreshed from the server.
  await expect(row.getByRole("cell", { name: "User Administrator", exact: true })).toBeVisible();
  await page.reload();
  await expect(person.getByLabel(`Role for ${invitee}`)).toHaveValue("user_admin");
  await panelReady(page, /Invited Person/);
  await person.getByRole("button", { name: `Remove ${invitee}` }).click();
  const confirm = page.getByRole("alertdialog", { name: `Remove ${invitee}?` });
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(person).toHaveCount(0);
  await expect(page.getByRole("row", { name: new RegExp(invitee) })).toHaveCount(0);

  // The audit log recorded every step.
  await (await openNav(page)).getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();
  await page.getByLabel("Area").selectOption({ label: "Account and people" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  for (const label of ["Invite sent", "Invite accepted", "Role changed", "Person removed"]) {
    await expect(page.getByRole("row", { name: new RegExp(label) }).first()).toBeVisible();
  }
});

test("an owner revokes an invite and its link stops working", async ({ page, browser }, testInfo) => {
  const u = e2eUsers();
  const invitee = `${u.run}-${testInfo.project.name}-revoked@e2e.test`;
  await signIn(page, u.users.owner, u.password);
  await (await openNav(page)).getByRole("link", { name: "People and roles" }).click();
  await expect(page.getByRole("heading", { name: "People and roles", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Invite someone" }).click();
  await page.getByLabel("Email").fill(invitee);
  await page.getByRole("button", { name: "Send invite" }).click();
  const row = page.getByRole("row", { name: new RegExp(invitee) });
  await expect(row).toBeVisible();
  await page.keyboard.press("Escape");
  const link = await linkFromMail(page.request, invitee, /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]{43}/);
  await row.getByRole("button", { name: `Actions for the invite to ${invitee}` }).click();
  await page.getByRole("menuitem", { name: "Revoke invite…" }).click();
  await page
    .getByRole("alertdialog", { name: "Revoke this invite?" })
    .getByRole("button", { name: "Revoke invite" })
    .click();
  await expect(page.getByRole("row", { name: new RegExp(invitee) })).toHaveCount(0);
  const other = await browser.newContext();
  const guest = await other.newPage();
  await guest.goto(link);
  await expect(guest.getByRole("alert").filter({ hasText: "been revoked" })).toBeVisible();
  await other.close();
});

test("a User Administrator invites Members only and can't remove the owner", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.userAdmin, u.password);
  await (await openNav(page)).getByRole("link", { name: "People and roles" }).click();
  await expect(page.getByRole("heading", { name: "People and roles", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Invite someone" }).click();
  await expect(page.getByLabel("Role", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Role", { exact: true })).toHaveValue("member");
  await page.keyboard.press("Escape");
  // The owner's row offers neither removal nor a role change; nor does their panel.
  const owner = page.getByRole("row", { name: new RegExp(u.users.owner) });
  await owner.getByRole("button", { name: `Actions for ${u.users.owner}` }).click();
  await expect(page.getByRole("menuitem", { name: "Remove…" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Change role" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Open details" }).click();
  const ownerPanel = page.getByRole("dialog");
  await expect(ownerPanel.getByRole("button", { name: `Remove ${u.users.owner}` })).toHaveCount(0);
  await expect(ownerPanel.getByRole("tab", { name: "Role" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // The member's row offers removal but no role change.
  const member = page.getByRole("row", { name: new RegExp(u.users.member) });
  await member.getByRole("button", { name: `Actions for ${u.users.member}` }).click();
  await expect(page.getByRole("menuitem", { name: "Remove…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Change role" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // The server refuses what the page hides (403).
  const people = new URL(page.url()).pathname;
  const accountId = people.split("/")[2] ?? "";
  const res = await page.request.post(`${urls.app}/api/accounts/${accountId}/invites`, {
    headers: { origin: urls.app },
    data: { email: `${u.run}-nope@e2e.test`, role: "owner" },
  });
  expect(res.status()).toBe(403);
});

test("a Member has no People page; the platform pages are a 404 for customers", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.member, u.password);
  const nav = await openNav(page);
  await expect(nav.locator(`[data-nav="member.read"]`)).toHaveCount(0);
  await page.goto(`${urls.app}/platform/accounts`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.goto(`${urls.app}/platform/audit`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
