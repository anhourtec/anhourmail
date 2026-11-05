// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, actingStaff, req } from "../__tests__/helpers";
import {
  auditor,
  fakeSealer,
  importWorld,
  MBX_MEMBER,
  MBX_OWNER,
  MBX_SHARED,
  member,
  owner,
  ownerB,
  SESSION,
  userAdmin,
} from "../__tests__/imports";
import { BusyError, ForbiddenError, NotFoundError, StepUpRequiredError, ValidationError } from "../errors";
import { IMPORT_BATCH_TEMPLATE } from "@anhourmail/shared/import";

import { getImportBatch, importBatchReport, startImportBatch } from "./batch";
import { openSourceSecret } from "./secrets";
import { startImport } from "./service";

const enc = (s: string) => new TextEncoder().encode(s);
const HEADER = "mailbox,source_host,source_port,source_username,source_password,exclude_junk_trash,sync";
const row = (
  mailbox: string,
  extra: Partial<Record<"host" | "port" | "user" | "pass" | "junk" | "sync", string>> = {},
) =>
  [
    mailbox,
    extra.host ?? "imap.old-provider.example",
    extra.port ?? "993",
    extra.user ?? `${mailbox.split("@")[0] ?? ""}@old.example`,
    extra.pass ?? "app-pw",
    extra.junk ?? "",
    extra.sync ?? "",
  ].join(",");

function setup() {
  const w = importWorld();
  const ctx = { issuer: w.issuer, sealer: fakeSealer };
  const charged: number[] = [];
  const run = (
    csv: string,
    actor = userAdmin,
    sessionId: string | null = SESSION,
    charge = async (rows: number) => {
      charged.push(rows);
    },
  ) => startImportBatch(w.d, ctx, actor, ACCOUNT_A, enc(csv), { sessionId }, req, charge);
  const audits = (action: string) => w.s.audit.filter((a) => a.action === action);
  return { ...w, ctx, run, audits, charged };
}

describe("startImportBatch", () => {
  it("starts one import per valid row, each with its own credential, and reports the others by row and code", async () => {
    const t = setup();
    const csv = [
      HEADER,
      row("kid@family.ca", { sync: "yes", junk: "no" }),
      row("shop@family.ca"),
      row("nobody@family.ca"),
      row("mum@family.ca"),
      row("kid@family.ca"),
      row("paused@family.ca"),
      row("it@family.ca", { port: "995" }),
      "",
    ].join("\r\n");
    const { result, notices } = await t.run(csv);
    expect(result.rows).toBe(7);
    expect(result.started.map((s) => s.address)).toEqual(["kid@family.ca", "shop@family.ca"]);
    expect(result.invalid).toEqual([
      { row: 4, code: "mailbox_not_found" },
      // An Owner's mailbox: Owners only.
      { row: 5, code: "forbidden" },
      { row: 6, code: "duplicate_mailbox" },
      { row: 7, code: "mailbox_unavailable" },
      { row: 8, code: "invalid_port" },
    ]);
    expect(t.issuer.minted).toHaveLength(2);
    const rows = t.s.mailImports;
    expect(rows.every((r) => r.batchId === result.batchId)).toBe(true);
    const kid = rows.find((r) => r.mailboxId === MBX_MEMBER);
    expect(kid?.options).toEqual({ excludeJunkTrash: false, intoSubfolder: false, sync: true });
    expect(kid?.sourceSecret && openSourceSecret(fakeSealer, kid.id, kid.sourceSecret)).toBe("app-pw");
    // The member is told an admin started it; the shared mailbox has nobody to tell.
    expect(notices.map((n) => n.to)).toEqual(["member@example.ca"]);
    const [batch] = t.audits("data.import_batch_created");
    expect(batch?.meta).toMatchObject({ rows: 7, valid: 2, invalid: 5, batchId: result.batchId });
    const started = t.audits("data.import_started");
    expect(started).toHaveLength(2);
    expect(started[0]?.meta).toMatchObject({ batchId: result.batchId, requestedAs: "admin" });
    expect(JSON.stringify(t.s.audit)).not.toMatch(/app-pw|@old\.example/);
  });

  it("lets an Owner import into their own mailbox (own) and an admin's", async () => {
    const t = setup();
    const { result } = await t.run([HEADER, row("mum@family.ca"), row("it@family.ca")].join("\n"), owner);
    expect(result.started).toHaveLength(2);
    expect(t.s.mailImports.find((r) => r.mailboxId === MBX_OWNER)?.requestedAs).toBe("own");
  });

  it("reports a mailbox that already has an import, and records nothing when no row is valid", async () => {
    const t = setup();
    await startImport(
      t.d,
      t.ctx,
      member,
      ACCOUNT_A,
      { mailboxId: MBX_MEMBER, host: "imap.old-provider.example", port: 993, username: "a", password: "b" },
      { sessionId: SESSION },
      req,
    );
    const { result } = await t.run([HEADER, row("kid@family.ca")].join("\n"));
    expect(result).toEqual({ batchId: null, rows: 1, started: [], invalid: [{ row: 2, code: "import_running" }] });
    expect(t.s.mailImportBatches).toHaveLength(0);
    expect(t.audits("data.import_batch_created")[0]?.meta).toMatchObject({ rows: 1, valid: 0, invalid: 1 });
  });

  it("names the field that is wrong, never the value", async () => {
    const t = setup();
    const { result } = await t.run(
      [
        HEADER,
        row("kid@family.ca", { host: "localhost" }),
        row("shop@family.ca", { user: "" }),
        row("it@family.ca", { pass: "" }),
      ].join("\n"),
      owner,
    );
    expect(result.invalid).toEqual([
      { row: 2, code: "invalid_host" },
      { row: 3, code: "invalid_username" },
      { row: 4, code: "invalid_password" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/localhost|app-pw/);
  });

  it("checks the options' values and accepts the columns in any order, optional ones left out", async () => {
    const t = setup();
    const { result } = await t.run(
      [
        "source_password,mailbox,source_username,source_host,sync",
        "app-pw,KID@family.ca,kid,imap.old-provider.example,maybe",
        "app-pw,shop@family.ca,shop,imap.old-provider.example,",
      ].join("\n"),
    );
    expect(result.invalid).toEqual([{ row: 2, code: "invalid_option" }]);
    expect(result.started.map((s) => s.address)).toEqual(["shop@family.ca"]);
    expect(t.s.mailImports[0]?.sourcePort).toBe(993);
  });

  it("refuses a file without the required columns, an empty file, or more rows than an account can have mailboxes", async () => {
    const t = setup();
    await expect(t.run("mailbox,source_host\nkid@family.ca,x")).rejects.toThrow(ValidationError);
    await expect(t.run(HEADER)).rejects.toThrow(/no rows/);
    const many = [HEADER, ...Array.from({ length: 11 }, (_, i) => row(`x${String(i)}@family.ca`))].join("\n");
    await expect(t.run(many)).rejects.toThrow(/up to 10 rows/);
    expect(t.issuer.minted).toHaveLength(0);
    expect(t.audits("data.import_batch_created").every((a) => a.result === "failed")).toBe(true);
  });

  it("needs a fresh step-up, refuses act-as, people without mailbox.import.any and other accounts", async () => {
    const t = setup();
    const csv = [HEADER, row("kid@family.ca")].join("\n");
    await expect(t.run(csv, userAdmin, null)).rejects.toThrow(StepUpRequiredError);
    await expect(t.run(csv, member)).rejects.toThrow(ForbiddenError);
    await expect(t.run(csv, auditor)).rejects.toThrow(ForbiddenError);
    await expect(t.run(csv, ownerB)).rejects.toThrow(NotFoundError);
    await expect(t.run(csv, actingStaff(ACCOUNT_A))).rejects.toThrow(ForbiddenError);
    expect(t.issuer.minted).toHaveLength(0);
    expect(t.audits("data.import_batch_created").map((a) => a.errorCode)).toContain("step_up_required");
  });

  it("charges the account's daily starts once per valid row before minting, and mints nothing when refused", async () => {
    const t = setup();
    const csv = [HEADER, row("kid@family.ca"), row("shop@family.ca"), row("nobody@family.ca")].join("\n");
    await t.run(csv);
    expect(t.charged).toEqual([2]);
    const u = setup();
    await expect(
      u.run(csv, userAdmin, SESSION, async () => {
        // The route's charge throws its 429 (any domain error stops the batch the same way).
        throw new BusyError();
      }),
    ).rejects.toThrow(BusyError);
    expect(u.issuer.minted).toHaveLength(0);
    expect(u.s.mailImportBatches).toHaveLength(0);
    // Nothing valid: nothing to charge.
    const v = setup();
    await v.run([HEADER, row("nobody@family.ca")].join("\n"));
    expect(v.charged).toEqual([]);
  });

  it("destroys the credential of a row whose import couldn't be recorded, and starts the others (SA-66-04)", async () => {
    const t = setup();
    const real = t.issuer.mint.bind(t.issuer);
    t.issuer.mint = async (account, expiresAt) => {
      const made = await real(account, expiresAt);
      // Another import of the shop mailbox lands between the checks and the insert.
      if (account === "s-acac") {
        const template = t.s.mailImports[0];
        if (template) t.s.mailImports.push({ ...template, id: crypto.randomUUID(), mailboxId: MBX_SHARED });
      }
      return made;
    };
    const { result } = await t.run([HEADER, row("kid@family.ca"), row("shop@family.ca")].join("\n"));
    expect(result.started.map((x) => x.address)).toEqual(["kid@family.ca"]);
    expect(result.invalid).toEqual([{ row: 3, code: "import_running" }]);
    expect(t.issuer.minted).toHaveLength(2);
    expect(t.issuer.destroyed).toEqual([t.issuer.minted[1]?.id ?? ""]);
  });

  it("destroys every credential it minted when recording fails", async () => {
    const t = setup();
    const real = t.issuer.mint.bind(t.issuer);
    let n = 0;
    t.issuer.mint = async (account, expiresAt) => {
      n += 1;
      if (n === 2) throw new Error("mail server down");
      return real(account, expiresAt);
    };
    await expect(t.run([HEADER, row("kid@family.ca"), row("shop@family.ca")].join("\n"))).rejects.toThrow(
      "mail server down",
    );
    expect(t.issuer.destroyed).toHaveLength(1);
    expect(t.s.mailImports).toHaveLength(0);
    expect(t.s.mailImportBatches).toHaveLength(0);
  });
});

describe("getImportBatch and its report", () => {
  it("shows the batch's imports to admins of the account and writes a formula-safe report", async () => {
    const t = setup();
    const { result } = await t.run([HEADER, row("kid@family.ca"), row("shop@family.ca")].join("\n"));
    const id = result.batchId ?? "";
    const batch = await getImportBatch(t.d, userAdmin, ACCOUNT_A, id);
    expect(batch).toMatchObject({ id, rows: 2, createdByYou: true });
    expect(batch.imports.map((i) => i.mailboxId).sort()).toEqual([MBX_MEMBER, MBX_SHARED].sort());
    const report = importBatchReport({
      ...batch,
      imports: [{ ...(batch.imports[0] ?? batch.imports[0]!), address: "=cmd@family.ca" }],
    });
    expect(report.split("\r\n")[0]).toBe("mailbox,status,messages,duplicates,too_large,failed,error");
    expect(report).toContain("'=cmd@family.ca");
    expect((await getImportBatch(t.d, owner, ACCOUNT_A, id)).createdByYou).toBe(false);
    await expect(getImportBatch(t.d, member, ACCOUNT_A, id)).rejects.toThrow(ForbiddenError);
    await expect(getImportBatch(t.d, ownerB, ACCOUNT_B, id)).rejects.toThrow(NotFoundError);
    await expect(getImportBatch(t.d, userAdmin, ACCOUNT_A, "not-an-id")).rejects.toThrow(NotFoundError);
  });

  it("has a template with the columns and placeholders only", () => {
    expect(IMPORT_BATCH_TEMPLATE.split("\r\n")[0]).toBe(HEADER);
    expect(IMPORT_BATCH_TEMPLATE).toMatch(/example\.(com|net)/);
  });
});
