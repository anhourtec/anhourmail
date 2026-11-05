// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail Contacts → Import (ADR-0030 §10): a CSV file whose columns are detected, one mapping changed (a column we
 * don't recognise imported as the company) and one left out, the result counts, the imported contact as mapped, and
 * the same file again merging into what's there (nothing added twice). Uses this run's own mailbox; addresses carry a
 * per-test tag and the contacts are deleted afterwards.
 */
import type { Page } from "@playwright/test";

import { e2eUsers, expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

test.use({ trace: "off" });

async function signInWebmail(page: Page, address: string, password: string) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  // The Next.js dev indicator sits over the phone layout's corner.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

async function openContacts(page: Page) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
  await nav.getByRole("button", { name: "Contacts" }).click();
  await expect(page.getByRole("heading", { name: "Contacts", level: 1 })).toBeVisible();
  // Loaded: the group buttons show their counts.
  await expect(
    page.getByRole("group", { name: "Contact groups" }).getByRole("button", { name: /^All ?\d/ }),
  ).toBeVisible();
}

/** On phones a contact replaces the contact list: go back to it. */
async function backToContacts(page: Page) {
  const back = page.getByRole("button", { name: "Back to contacts" });
  if (await back.isVisible()) await back.click();
}

async function importFile(page: Page, name: string, csv: string) {
  await page.getByRole("button", { name: "Contacts options" }).click();
  await page.getByRole("menuitem", { name: "Import contacts" }).click();
  const dialog = page.getByRole("dialog", { name: "Import contacts" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Contacts file").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(csv) });
}

test("imports a CSV after changing the column mapping, and merges the same file into what's there", async ({
  page,
  consoleErrors,
}) => {
  const { recipient } = e2eUsers();
  const tag = Math.random().toString(36).slice(2, 8);
  const csv = [
    "First Name;Last Name;E-mail Address;Team;Notes",
    `Rowan;Import ${tag};rowan-${tag}@example.org;Harbour Rowing;private note`,
    `Kai;Import ${tag};kai-${tag}@example.org;;`,
  ].join("\r\n");

  await signInWebmail(page, recipient.address, recipient.password);
  await openContacts(page);
  await importFile(page, "people.csv", csv);

  // The mapping step: detected fields, examples from the first rows; "Team" isn't recognised.
  const map = page.getByRole("dialog", { name: "Choose what each column holds" });
  await expect(map).toBeVisible();
  await expect(map.getByText("2 contacts in")).toBeVisible();
  await expect(map.getByLabel("Import First Name as")).toHaveValue("given");
  await expect(map.getByLabel("Import E-mail Address as")).toHaveValue("emails");
  await expect(map.getByLabel("Import Team as")).toHaveValue("");
  await expect(map.getByText("Harbour Rowing")).toBeVisible();
  await map.getByLabel("Import Team as").selectOption({ label: "Company" });
  await map.getByLabel("Import Notes as").selectOption({ label: "Don't import" });
  await map.getByRole("button", { name: "Import contacts" }).click();

  const done = page.getByRole("dialog", { name: "Contacts imported" });
  await expect(done.getByRole("list", { name: "Import result" })).toContainText("2 new contacts added");
  await done.getByRole("button", { name: "Done" }).click();

  // Imported as mapped: the company from "Team", no notes.
  const list = page.getByRole("list", { name: "Contact list" });
  await page.getByRole("searchbox", { name: "Search contacts" }).fill(tag);
  await list.getByRole("button", { name: new RegExp(`Rowan Import ${tag}`) }).click();
  const rowan = page.getByRole("region", { name: `Contact: Rowan Import ${tag}` });
  await expect(rowan.getByText("Harbour Rowing")).toBeVisible();
  await expect(rowan.getByText("private note")).toHaveCount(0);
  await backToContacts(page);

  // The same file again: nothing new, nothing doubled.
  await importFile(page, "people.csv", csv);
  await map.getByRole("button", { name: "Import contacts" }).click();
  await expect(done.getByRole("list", { name: "Import result" })).toContainText("0 new contacts added");
  await expect(done.getByRole("list", { name: "Import result" })).toContainText("already in your contacts");
  await done.getByRole("button", { name: "Done" }).click();
  await expect(list.getByRole("button", { name: new RegExp(`Import ${tag}`) })).toHaveCount(2);

  // Tidy up: delete both.
  for (const who of ["Rowan", "Kai"]) {
    await list.getByRole("button", { name: new RegExp(`${who} Import ${tag}`) }).click();
    await page
      .getByRole("region", { name: `Contact: ${who} Import ${tag}` })
      .getByRole("button", { name: "Delete contact" })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(list.getByRole("button", { name: new RegExp(`${who} Import ${tag}`) })).toHaveCount(0);
  }
  expect(consoleErrors).toEqual([]);
});

test("refuses a CSV that isn't UTF-8 with what to do", async ({ page, consoleErrors }) => {
  const { recipient } = e2eUsers();
  await signInWebmail(page, recipient.address, recipient.password);
  await openContacts(page);
  await page.getByRole("button", { name: "Contacts options" }).click();
  await page.getByRole("menuitem", { name: "Import contacts" }).click();
  const dialog = page.getByRole("dialog", { name: "Import contacts" });
  // "Café" saved in a Windows code page (é as one byte).
  await dialog.getByLabel("Contacts file").setInputFiles({
    name: "old.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0d, 0x0a, 0x43, 0x61, 0x66, 0xe9]),
  });
  await expect(dialog.getByRole("alert")).toContainText("Save it as UTF-8");
  await dialog.getByRole("button", { name: "Close" }).last().click();
  await expect(dialog).toBeHidden();
  expect(consoleErrors).toEqual([]);
});
