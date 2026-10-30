// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mailbox delegation in the console (ADR-0026): an Owner gives a person Read and manage and Send as on a shared mailbox,
 * sees them listed and takes one away; converts a colleague's mailbox to a shared mailbox; and removes a leaver while
 * giving the same person full access to the leaver's mailbox, which then lists them. Each change is one batch the
 * server may ask to confirm with the console password first (a fresh sign-in counts, so it may not ask).
 */
import type { Locator, Page } from "@playwright/test";

import { e2eUsers, expect, openNav, panel, SIGN_IN_TIMEOUT, signIn, test } from "./fixtures";

/**
 * Waits for the change to land (`done` visible, or gone with `gone: true`); if the server asks to confirm it's you
 * first, confirms with the console password.
 */
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

test("an owner gives and takes away access, converts a mailbox to shared and hands a leaver's mailbox over", async ({
  page,
  consoleErrors,
}, testInfo) => {
  test.setTimeout(90_000);
  const u = e2eUsers();
  const dl = u.delegation[testInfo.project.name] ?? {
    owner: "",
    delegate: "",
    colleague: "",
    leaver: "",
    domain: "",
    shared: "",
  };
  // People are named after their fixture key ("dl-desktop-delegate").
  const delegateName = `dl-${testInfo.project.name}-delegate`;
  await signIn(page, dl.owner, u.password);

  // The shared mailbox's Delegation tab: three separate lists, empty to start with.
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("link", { name: dl.shared }).click();
  const details = panel(page, dl.shared);
  await expect(details.getByText("Nobody: it's a shared mailbox")).toBeVisible();
  await details.getByRole("tab", { name: "Delegation" }).click();
  const readManage = details.getByRole("region", { name: "Read and manage" });
  const sendAs = details.getByRole("region", { name: "Send as" });
  const onBehalf = details.getByRole("region", { name: "Send on behalf" });
  await expect(readManage.getByText("Nobody has this yet.")).toBeVisible();
  await expect(onBehalf.getByText("Nobody has this yet.")).toBeVisible();
  // The send rights first, then Read and manage; each heading counts its people.
  await expect(details.getByRole("heading", { level: 3 })).toHaveText([
    "Send as (0)",
    "Send on behalf (0)",
    "Read and manage (0)",
  ]);

  // Read and manage for the delegate (the picker never offers people already on the list).
  await readManage.getByRole("button", { name: "Add people to Read and manage" }).click();
  await readManage.getByRole("checkbox", { name: new RegExp(dl.delegate) }).check();
  await readManage.getByRole("button", { name: "Add", exact: true }).click();
  await confirmIfAsked(page, readManage.getByRole("listitem").filter({ hasText: dl.delegate }), u.password);
  await expect(details.getByRole("status").filter({ hasText: "Added 1 person to Read and manage." })).toBeVisible();

  // Send as too.
  await sendAs.getByRole("button", { name: "Add people to Send as" }).click();
  await sendAs.getByRole("checkbox", { name: new RegExp(dl.delegate) }).check();
  await sendAs.getByRole("button", { name: "Add", exact: true }).click();
  await confirmIfAsked(page, sendAs.getByRole("listitem").filter({ hasText: dl.delegate }), u.password);

  // A reload shows both (they're stored), then Send as is taken away again.
  await page.reload();
  await expect(readManage.getByRole("listitem").filter({ hasText: dl.delegate })).toBeVisible();
  await expect(sendAs.getByRole("listitem").filter({ hasText: dl.delegate })).toBeVisible();
  await expect(sendAs.getByRole("heading", { level: 3 })).toHaveText("Send as (1)");
  await sendAs.getByRole("button", { name: new RegExp(`^Remove .* from Send as$`) }).click();
  await confirmIfAsked(page, sendAs.getByText("Nobody has this yet."), u.password);
  await expect(readManage.getByRole("listitem").filter({ hasText: dl.delegate })).toBeVisible();

  // The delegate's People panel lists the mailbox they can open.
  await page.keyboard.press("Escape");
  await (await openNav(page)).getByRole("link", { name: "People and roles" }).click();
  await page.getByRole("link", { name: delegateName, exact: true }).click();
  const person = panel(page, delegateName);
  await expect(person.getByRole("link", { name: dl.shared })).toBeVisible();
  await expect(person.getByText("Read and manage", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Convert the colleague's mailbox to a shared mailbox.
  const colleagueBox = `colleague@${dl.domain}`;
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("button", { name: `Actions for ${colleagueBox}` }).click();
  await page.getByRole("menuitem", { name: "Convert to shared mailbox…" }).click();
  const converting = panel(page, colleagueBox);
  await converting.getByRole("button", { name: "Convert to shared mailbox…" }).click();
  const convertNow = converting.getByRole("button", { name: "Convert to shared mailbox", exact: true });
  await convertNow.click();
  await confirmIfAsked(page, convertNow, u.password, true);
  await converting.getByRole("tab", { name: "Overview" }).click();
  await expect(converting.getByText("Nobody: it's a shared mailbox")).toBeVisible();
  await page.keyboard.press("Escape");

  // Remove the leaver, giving the delegate full access to their mailbox (and send as).
  const leaverBox = `leaver@${dl.domain}`;
  await (await openNav(page)).getByRole("link", { name: "People and roles" }).click();
  await page.getByRole("button", { name: `Actions for ${dl.leaver}` }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  const removing = page.getByRole("alertdialog", { name: `Remove ${dl.leaver}?` });
  await expect(removing.getByText("as a shared mailbox with their sign-in turned off")).toBeVisible();
  await removing
    .getByLabel("Give full access to their mailbox to")
    .selectOption({ label: `${delegateName} (${dl.delegate})` });
  await removing.getByLabel("Also let them send as it").check();
  await removing.getByRole("button", { name: "Remove", exact: true }).click();
  await confirmIfAsked(page, page.getByRole("row", { name: new RegExp(dl.leaver) }), u.password, true);

  // The leaver's mailbox is now a shared mailbox the delegate can read and manage and send as.
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("link", { name: leaverBox }).click();
  const handedOver = panel(page, leaverBox);
  await expect(handedOver.getByText("Nobody: it's a shared mailbox")).toBeVisible();
  await handedOver.getByRole("tab", { name: "Delegation" }).click();
  await expect(
    handedOver.getByRole("region", { name: "Read and manage" }).getByRole("listitem").filter({ hasText: dl.delegate }),
  ).toBeVisible();
  await expect(
    handedOver.getByRole("region", { name: "Send as" }).getByRole("listitem").filter({ hasText: dl.delegate }),
  ).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
