// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mail import (ADR-0030 slices 10–11). A Member imports their own mailbox from a source mailbox on the dev mail server
 * (outside production imports can only read from it) and watches it finish, then gets the summary email; a User Admin
 * runs a CSV batch into two of the account's mailboxes, sees the row that didn't start, follows the batch and
 * downloads its report. Needs the importer running (`npm run dev` starts it). The source's content comes from
 * `scripts/seed/import-source.ts`: 25 messages, one flagged `\Deleted` (skipped), one Message-ID twice (one skipped as a
 * duplicate); Junk and Deleted Items are left out by default.
 */
import { execFileSync } from "node:child_process";

import { type E2eUsers, e2eUsers, expect, linkFromMail, signIn, test, urls } from "./fixtures";

test.describe.configure({ mode: "serial" });

/** This browser project's import fixture (scripts/e2e-fixtures.ts makes one per project). */
const fixture = (u: E2eUsers, project: string): E2eUsers["imports"][string] =>
  u.imports[project] ?? {
    accountId: "",
    member: "",
    userAdmin: "",
    mailbox: "",
    batch: [],
    source: { address: "", password: "" },
  };

test("a member imports their own mailbox from another server and sees it finish", async ({ page, request }, info) => {
  test.setTimeout(180_000);
  const u = e2eUsers();
  const im = fixture(u, info.project.name);
  await signIn(page, im.member, u.password);
  await page.goto(`${urls.app}/accounts/${im.accountId}/import`);
  await expect(page.getByRole("heading", { name: "Import mail", level: 1 })).toBeVisible();
  await expect(page.getByText("No imports yet.")).toBeVisible();
  // A member has no batch.
  await expect(page.getByRole("link", { name: "Import many mailboxes (CSV)" })).toHaveCount(0);
  await page.getByRole("link", { name: "New import" }).click();
  await expect(page.getByRole("heading", { name: "New import", level: 1 })).toBeVisible();

  // Their own mailbox is the only choice; a preset shows its server, "Other IMAP server" asks for one.
  const into = page.getByLabel("Import into");
  await expect(into.locator("option")).toHaveCount(1);
  await expect(into).toHaveValue(/.+/);
  await page.getByLabel("Provider", { exact: true }).selectOption({ label: "Gmail" });
  await expect(page.getByText("imap.gmail.com")).toBeVisible();
  await page.getByLabel("Provider", { exact: true }).selectOption({ label: "Other IMAP server" });
  await page.getByLabel("IMAP server", { exact: true }).fill("127.0.0.1");
  await expect(page.getByLabel("Port", { exact: true })).toHaveValue("993");
  await page.getByLabel("User name", { exact: true }).fill(im.source.address);
  await page.getByLabel("App password", { exact: true }).fill(im.source.password);
  await expect(page.getByLabel("Leave out Junk and Deleted items")).toBeChecked();
  await page.getByRole("button", { name: "Start import" }).click();

  // Signing in just now counts as confirming it's them; the import's page opens and fills in as it runs.
  await expect(page.getByRole("heading", { name: `Import into ${im.mailbox}`, level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  expect(await page.content()).not.toContain(im.source.password);
  await expect(page.getByRole("heading", { name: "Finished", level: 2 })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("progressbar", { name: "Import progress" })).toHaveAttribute("aria-valuenow", "100");
  const folders = page.getByRole("table", { name: "Folders" });
  await expect(folders.getByRole("row", { name: /^Inbox/ })).toBeVisible();
  await expect(folders.getByRole("row", { name: /^Sent/ })).toBeVisible();
  // Finished history keeps roles and counts only: custom folders show without their names.
  await expect(folders.getByText("Projects/2015/Q1")).toHaveCount(0);
  await expect(folders.getByRole("row", { name: /^Other folders/ }).first()).toBeVisible();
  // Copied: 15 Inbox (17 less the deleted one and a duplicate) + 4 custom + Sent + Drafts = 21.
  await expect(page.getByText("21 of", { exact: false })).toBeVisible();
  // No controls on a finished import.
  await expect(page.getByRole("button", { name: "Cancel import" })).toHaveCount(0);

  // The list shows it finished.
  // Back through the breadcrumb (the left navigation also links "Import mail" on wide screens).
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Import mail" }).click();
  const row = page.getByRole("row", { name: new RegExp(im.mailbox) });
  await expect(row.getByText("Finished")).toBeVisible();

  // The summary email (the scheduler's job:import-notify, run here once): counts per role, a link to the import.
  execFileSync("npx", ["tsx", "--env-file-if-exists=.env", "apps/worker/src/jobs/import-notify.ts"], {
    stdio: "ignore",
  });
  const link = await linkFromMail(request, im.member, /https?:\/\/\S+\/accounts\/[\w-]+\/import\/[\w-]+/);
  expect(link).toContain(`/accounts/${im.accountId}/import/`);
});

test("a user admin imports two mailboxes from one CSV and downloads the report", async ({ page }, info) => {
  test.setTimeout(180_000);
  const u = e2eUsers();
  const im = fixture(u, info.project.name);
  const [ana = "", ben = ""] = im.batch;
  await signIn(page, im.userAdmin, u.password);
  await page.goto(`${urls.app}/accounts/${im.accountId}/import`);
  // The admin sees the member's import too.
  await expect(page.getByRole("row", { name: new RegExp(im.mailbox) })).toBeVisible();
  await page.getByRole("link", { name: "Import many mailboxes (CSV)" }).click();
  await expect(page.getByRole("heading", { name: "Import many mailboxes", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download template" })).toHaveAttribute(
    "download",
    "import-template.csv",
  );

  const csv = [
    "mailbox,source_host,source_port,source_username,source_password,exclude_junk_trash,sync",
    `${ana},127.0.0.1,993,${im.source.address},${im.source.password},yes,no`,
    `${ben},127.0.0.1,993,${im.source.address},${im.source.password},,`,
    `nobody@${ana.split("@")[1] ?? ""},127.0.0.1,993,x,y,,`,
  ].join("\r\n");
  await page
    .getByLabel(/^CSV file/)
    .setInputFiles({ name: "team.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Upload and start" }).click();
  const result = page.getByRole("status").filter({ hasText: "2 of 3 rows started" });
  await expect(result).toBeVisible({ timeout: 15_000 });
  await expect(result.getByRole("row", { name: /4 No mailbox with that address/ })).toBeVisible();
  expect(await page.content()).not.toContain(im.source.password);

  await result.getByRole("link", { name: "Follow this batch" }).click();
  await expect(page.getByRole("heading", { name: "Import batch", level: 1 })).toBeVisible();
  const list = page.getByRole("table", { name: "Imports in this batch" });
  for (const address of [ana, ben]) {
    await expect(list.getByRole("row", { name: new RegExp(address) }).getByText("Finished")).toBeVisible({
      timeout: 120_000,
    });
  }
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download report" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^import-batch-\d{4}-\d{2}-\d{2}\.csv$/);
  const path = await file.path();
  const { readFileSync } = await import("node:fs");
  const report = readFileSync(path, "utf8");
  expect(report.split("\r\n")[0]).toBe("mailbox,status,messages,duplicates,too_large,failed,error");
  expect(report).toContain(`${ana},completed,21,`);
  expect(report).not.toContain(im.source.password);
});
