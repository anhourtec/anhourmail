// SPDX-License-Identifier: AGPL-3.0-only
/** Aliases and masked aliases (Phase 3) on a mailbox of a domain verified through the development DNS. */
import type { TestInfo } from "@playwright/test";

import { ALIAS_CREATIONS_PER_YEAR, ALIAS_YEAR_DAYS, ALIASES_PER_MAILBOX } from "@anhourmail/shared/plans";

import { e2eUsers, expect, openNav, panel, signIn, signOut, test, verifyDomain } from "./fixtures";

test("an owner adds, turns off and deletes aliases; the member sees only their own and can't undo an admin's off", async ({
  page,
}, testInfo) => {
  const u = e2eUsers();
  const domain = `${u.run}-als-${testInfo.project.name}.test`;
  await signIn(page, u.users.owner, u.password);

  // A verified domain and two mailboxes: the owner's and the member's.
  await (await openNav(page)).getByRole("link", { name: "Domains" }).click();
  await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Add a domain" }).click();
  await page.getByLabel("Domain name").fill(domain);
  await page.getByRole("button", { name: "Add domain" }).click();
  await verifyDomain(page, domain);
  await page.keyboard.press("Escape");
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await expect(page.getByRole("heading", { name: "Mailboxes", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Add a shared address" }).click();
  for (const [local, owner] of [
    ["boss", u.users.owner],
    ["kid", u.users.member],
  ] as const) {
    await page.getByLabel("Address", { exact: true }).fill(local);
    await page.getByLabel("Domain").selectOption({ label: domain });
    await page.getByLabel("Belongs to").selectOption({ label: owner });
    await page.getByLabel("Storage (GB)").fill("1");
    await page.getByLabel("Password", { exact: true }).fill("e2e mailbox password");
    await page.getByRole("button", { name: "Create shared address" }).click();
    await expect(page.getByRole("row", { name: new RegExp(`${local}@${domain}`) })).toBeVisible();
  }
  await page.keyboard.press("Escape");

  await (await openNav(page)).getByRole("link", { name: "Aliases" }).click();
  await expect(page.getByRole("heading", { name: "Aliases", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Add an alias" }).click();
  const adding = panel(page, "Add an alias");

  // A chosen alias for the member's mailbox.
  await page.getByLabel("Address", { exact: true }).fill("Hello");
  await page.getByLabel("Domain").selectOption({ label: domain });
  await page.getByLabel("Delivers to").selectOption({ label: `kid@${domain}` });
  await page.getByLabel(/Note/).fill("school");
  await page.getByRole("button", { name: "Create alias" }).click();
  const hello = page.getByRole("row", { name: new RegExp(`hello@${domain}`) });
  await expect(hello).toBeVisible();
  await expect(hello.getByText("school")).toBeAttached();
  // Paid plans: addresses per mailbox (aliases and masked aliases together), no yearly count.
  const perMailbox = page.getByTestId("alias-mailbox-counts");
  await expect(perMailbox).toContainText(`up to ${String(ALIASES_PER_MAILBOX)} each`);
  await expect(perMailbox).toContainText(`kid@${domain} 1`);
  await expect(page.getByTestId("alias-year-remaining")).toHaveCount(0);

  // An address that's already a mailbox is refused.
  await page.getByLabel("Address", { exact: true }).fill("boss");
  await page.getByLabel("Domain").selectOption({ label: domain });
  await page.getByRole("button", { name: "Create alias" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That address is already in use." })).toBeVisible();

  // A masked alias for the owner's own mailbox: random, shown with a copy button.
  await adding.getByRole("radio", { name: "Masked" }).click();
  await page.getByLabel("Delivers to").selectOption({ label: `boss@${domain}` });
  await page.getByRole("button", { name: "Create masked alias" }).click();
  const created = adding.getByRole("status").filter({ hasText: "Created." });
  await expect(created).toBeVisible();
  const masked = (await created.locator("code").textContent()) ?? "";
  expect(masked).toMatch(new RegExp(`^[a-z2-9]{12}@${domain.replace(/\./g, "\\.")}$`));
  await page.keyboard.press("Escape");
  await expect(adding).toHaveCount(0);
  const maskedRow = page.getByRole("row", { name: new RegExp(masked.replace(/\./g, "\\.")) });
  await expect(maskedRow.getByText("Masked")).toBeVisible();

  // Off, then deleted (from the row's menu, with a confirmation that names it).
  await maskedRow.getByRole("switch", { name: `Receive mail at ${masked}` }).click();
  await expect(maskedRow.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect(maskedRow.getByText("Off")).toBeVisible();
  await maskedRow.getByRole("button", { name: `Actions for ${masked}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete this alias?" });
  await expect(confirm.getByText(masked)).toBeVisible();
  await confirm.getByRole("button", { name: "Delete alias" }).click();
  await expect(maskedRow).toHaveCount(0);

  // The owner turns off the member's alias: it's locked off for the member.
  await hello.getByRole("switch", { name: `Receive mail at hello@${domain}` }).click();
  await expect(hello.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect(hello.getByText("Turned off by an administrator")).toBeVisible();

  // The member sees the Aliases section with only their mailbox's alias, and can't turn that one back on or delete it.
  await signOut(page);
  await signIn(page, u.users.member, u.password);
  await (await openNav(page)).getByRole("link", { name: "Aliases" }).click();
  const memberHello = page.getByRole("row", { name: new RegExp(`hello@${domain}`) });
  await expect(memberHello).toBeVisible();
  await expect(memberHello.getByText("Turned off by an administrator")).toBeVisible();
  await expect(memberHello.getByRole("switch", { name: `Receive mail at hello@${domain}` })).toBeDisabled();
  await memberHello.getByRole("button", { name: `Actions for hello@${domain}` }).click();
  await expect(page.getByRole("menuitem", { name: "Turn on" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Add an alias" }).click();
  // Other tests in the run give the member mailboxes too, so check only this test's two.
  const options = page.getByLabel("Delivers to").locator("option");
  await expect(options.filter({ hasText: `kid@${domain}` })).toHaveCount(1);
  await expect(options.filter({ hasText: `boss@${domain}` })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The owner lifts it by turning it back on; the member manages it again.
  await signOut(page);
  await signIn(page, u.users.owner, u.password);
  await (await openNav(page)).getByRole("link", { name: "Aliases" }).click();
  await hello.getByRole("switch", { name: `Receive mail at hello@${domain}` }).click();
  await expect(hello.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await expect(hello.getByText("Turned off by an administrator")).toHaveCount(0);
});

const aliasLimitsFor = (info: TestInfo) => {
  const a = e2eUsers().aliasLimits[info.project.name];
  if (!a) throw new Error(`no alias limits fixture for ${info.project.name}`);
  return a;
};

test("on Free, a used-up year hides Add and says when more can be added", async ({ page }, testInfo) => {
  const al = aliasLimitsFor(testInfo);
  await signIn(page, al.owner, e2eUsers().password);
  await (await openNav(page)).getByRole("link", { name: "Aliases" }).click();
  await expect(page.getByRole("heading", { name: "Aliases", level: 1 })).toBeVisible();
  const perYear = ALIAS_CREATIONS_PER_YEAR.free;
  await expect(page.getByTestId("alias-year-remaining")).toContainText(
    `0 of ${String(perYear.alias)} aliases · 0 of ${String(perYear.masked)} masked aliases`,
  );
  const next = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(Date.parse(`${al.day}T00:00:00Z`) + ALIAS_YEAR_DAYS * 86_400_000),
  );
  await expect(page.getByRole("status").filter({ hasText: "the most its plan allows in a year" })).toContainText(
    `${String(perYear.alias)} new aliases this year (more on ${next})`,
  );
  await expect(page.getByRole("link", { name: "Add an alias" })).toHaveCount(0);
  // The panel's URL doesn't open it either; the server refuses a create regardless (unit and contract tests).
  await page.goto(`${page.url().split("?")[0] ?? ""}?new=1`);
  await expect(page.getByRole("heading", { name: "Add an alias" })).toHaveCount(0);
});
