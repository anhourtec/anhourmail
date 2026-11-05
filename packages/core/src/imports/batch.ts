// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The admins' batch migration (ADR-0030 §8): one CSV, one row per mailbox, each valid row its own import with its own
 * minted destination credential, all in one request. The file is parsed here and never stored; each row's secret is
 * sealed straight into its own `mail_import` row. Invalid rows come back as `{ row, code }`, never with their values.
 * Needs `mailbox.import.any`, a fresh step-up, and is refused while acting as someone (it mints).
 */
import { randomUUID } from "node:crypto";

import { parseCsv, toCsv } from "@anhourmail/shared/csv";
import {
  IMPORT,
  IMPORT_BATCH_COLUMNS,
  IMPORT_BATCH_REQUIRED,
  type ImportBatchColumn,
  type ImportBatchRowCode,
  isImportSourcePort,
} from "@anhourmail/shared/import";
import { MAX_MAILBOXES } from "@anhourmail/shared/plans";

import { type Actor, authorize, can } from "../actor";
import { ForbiddenError, NotFoundError, StepUpRequiredError, ValidationError } from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import { type AuditAlso, mutation, type MutationOutcome } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import { importOptions, type MailImportOptions } from "./entity";
import { ImportRefusedError } from "./errors";
import {
  accessTo,
  auditMeta,
  createImport,
  type ImportContext,
  type ImportNotice,
  type ImportView,
  mailboxImportable,
  view,
} from "./service";
import { importSource, importSourceSecret, MAX_SOURCE_USERNAME } from "./source";

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** One row the batch didn't start: its line in the file (the header is line 1) and why. */
export type ImportBatchRowError = { row: number; code: ImportBatchRowCode };

export type ImportBatchResult = {
  /** Null when no row was valid (nothing was recorded). */
  batchId: string | null;
  rows: number;
  started: { row: number; importId: string; address: string }[];
  invalid: ImportBatchRowError[];
};

export type ImportBatchView = {
  id: string;
  rows: number;
  createdAt: Date;
  createdByYou: boolean;
  imports: ImportView[];
};

const CSV_ERRORS: Record<string, string> = {
  encoding: "Save the file as UTF-8 (CSV UTF-8) and upload it again.",
  empty: "The file is empty. Use the template's header line and one row per mailbox.",
  too_large: `The file can be up to ${String(IMPORT.batchMaxBytes / 1024)} KB.`,
  too_many_rows: `The file can have up to ${String(MAX_MAILBOXES)} rows, one per mailbox.`,
  too_many_columns: "The file has too many columns. Use the template's columns.",
  cell_too_long: "A cell in the file is too long.",
  unterminated_quote: "A quoted value in the file is never closed.",
};

/** `yes`/`no`, `true`/`false`, `1`/`0` (any case) or empty for the default; anything else is null (invalid). */
function flag(value: string | undefined, fallback: boolean): boolean | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  if (v === "yes" || v === "true" || v === "1" || v === "y") return true;
  if (v === "no" || v === "false" || v === "0" || v === "n") return false;
  return null;
}

type ParsedRow = {
  row: number;
  address: string;
  input: { host: string; port: unknown; username: string; password: string };
  options: MailImportOptions;
};

/** Reads the table: header names, then one `ParsedRow` or error per data row (no mailbox checks yet). */
function readRows(bytes: Uint8Array, maxRows: number): (ParsedRow | ImportBatchRowError)[] {
  const parsed = parseCsv(bytes, { maxBytes: IMPORT.batchMaxBytes, maxRows, maxColumns: 20, maxCellLength: 2000 });
  if (!parsed.ok) throw new ValidationError(CSV_ERRORS[parsed.error] ?? "The file couldn't be read.");
  const header = parsed.table.header.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
  const index = new Map<ImportBatchColumn, number>();
  for (const c of IMPORT_BATCH_COLUMNS) {
    const i = header.indexOf(c);
    if (i >= 0) index.set(c, i);
  }
  const missing = IMPORT_BATCH_REQUIRED.filter((c) => !index.has(c));
  if (missing.length > 0)
    throw new ValidationError(`The file needs the column${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`);
  const out: (ParsedRow | ImportBatchRowError)[] = [];
  parsed.table.rows.forEach((cells, i) => {
    const row = i + 2;
    const get = (c: ImportBatchColumn) => {
      const at = index.get(c);
      return at === undefined ? undefined : cells[at];
    };
    if (cells.every((c) => c.trim() === "")) return;
    const portText = (get("source_port") ?? "").trim();
    const port = portText === "" ? IMPORT.defaultSourcePort : /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
    const excludeJunkTrash = flag(get("exclude_junk_trash"), true);
    const sync = flag(get("sync"), false);
    if (excludeJunkTrash === null || sync === null) {
      out.push({ row, code: "invalid_option" });
      return;
    }
    out.push({
      row,
      address: (get("mailbox") ?? "").trim().toLowerCase(),
      input: {
        host: get("source_host") ?? "",
        port,
        username: get("source_username") ?? "",
        password: get("source_password") ?? "",
      },
      options: importOptions({ excludeJunkTrash, sync, intoSubfolder: false }),
    });
  });
  return out;
}

/** Which field made `importSource` refuse a row (checked one at a time, so the code names it; never the value). */
function sourceProblem(input: ParsedRow["input"]): ImportBatchRowCode {
  if (!isImportSourcePort(input.port)) return "invalid_port";
  const username = input.username.trim();
  if (username === "" || username.length > MAX_SOURCE_USERNAME || /\p{Cc}/u.test(username)) return "invalid_username";
  try {
    importSourceSecret(input.password);
  } catch {
    return "invalid_password";
  }
  return "invalid_host";
}

const isRowError = (r: ParsedRow | ImportBatchRowError): r is ImportBatchRowError => "code" in r;

/**
 * Starts a batch: `bytes` is the CSV (columns `mailbox, source_host, source_port, source_username, source_password,
 * exclude_junk_trash, sync`; ≤ `IMPORT.batchMaxBytes`, at most `MAX_MAILBOXES` rows, the most mailboxes an account has). Each
 * valid row becomes a queued import of the batch, exactly as `startImport` makes one; a row for a mailbox that already
 * has an import is `import_running`. The valid rows are charged to the account's daily start budget first (`charge`;
 * the whole batch is refused when too few starts are left). If anything fails after a mint, every credential this request minted is
 * destroyed again and nothing is recorded. Audited `data.import_batch_created` (meta `rows`, `valid`, `invalid`) with
 * one `data.import_started` per started row in the same unit of work.
 */
export async function startImportBatch(
  deps: Deps,
  ctx: ImportContext,
  actor: Actor,
  accountId: string,
  bytes: Uint8Array,
  session: { sessionId: string | null },
  req: RequestMeta,
  /**
   * Charges the account's daily start budget once per valid row, before anything is minted (rule 27, run-66): throws
   * (429) when fewer than `rows` starts are left. The route passes a no-op for callers without `mailbox.import.own`
   * there (as for a single start, so nobody outside can use up an account's budget).
   */
  charge: (rows: number) => Promise<void> = async () => undefined,
): Promise<{ result: ImportBatchResult; notices: ImportNotice[] }> {
  const minted: { stalwartId: string; id: string }[] = [];
  try {
    const out = await mutation(
      deps,
      actor,
      req,
      {
        action: "data.import_batch_created",
        permission: "mailbox.import.any",
        accountId,
        target: { type: "mail_import_batch" },
      },
      async (
        repos,
      ): Promise<
        MutationOutcome<{ result: ImportBatchResult; notices: ImportNotice[] } | "act_as" | "step_up_required">
      > => {
        if (actor.kind !== "user") throw new ForbiddenError();
        if (actor.actingAs) return { result: "act_as", denied: { code: "act_as" } };
        const mailboxes = (await repos.mailboxes.listByAccount(accountId)).filter((m) => m.status !== "deleting");
        const rows = readRows(bytes, MAX_MAILBOXES);
        if (rows.length === 0) throw new ValidationError("The file has no rows. Add one row per mailbox.");
        const now = deps.clock.now();
        if (!session.sessionId || !(await repos.security.stepUpFresh(actor.userId, session.sessionId, now))) {
          return { result: "step_up_required", denied: { code: "step_up_required" } };
        }
        const byAddress = new Map(mailboxes.map((m) => [m.address.toLowerCase(), m] as const));
        const seen = new Set<string>();
        const invalid: ImportBatchRowError[] = [];
        const valid: {
          row: ParsedRow;
          mailbox: Mailbox;
          as: "own" | "admin";
          source: ReturnType<typeof importSource>;
        }[] = [];
        for (const r of rows) {
          if (isRowError(r)) {
            invalid.push(r);
            continue;
          }
          const m = byAddress.get(r.address);
          if (!m) {
            invalid.push({ row: r.row, code: "mailbox_not_found" });
            continue;
          }
          if (seen.has(m.id)) {
            invalid.push({ row: r.row, code: "duplicate_mailbox" });
            continue;
          }
          seen.add(m.id);
          const as = await accessTo(repos, actor, accountId, m);
          if (as === null) {
            invalid.push({ row: r.row, code: "forbidden" });
            continue;
          }
          let source: ReturnType<typeof importSource>;
          try {
            source = importSource(r.input, ctx.devSources, { allowListOnly: ctx.devSourcesOnly === true });
          } catch (err) {
            if (!(err instanceof ValidationError)) throw err;
            invalid.push({ row: r.row, code: sourceProblem(r.input) });
            continue;
          }
          if (!mailboxImportable(m)) {
            invalid.push({ row: r.row, code: "mailbox_unavailable" });
            continue;
          }
          if (await repos.imports.activeForMailbox(m.id)) {
            invalid.push({ row: r.row, code: "import_running" });
            continue;
          }
          valid.push({ row: r, mailbox: m, as, source });
        }
        const total = rows.length;
        const meta = { rows: total, valid: 0, invalid: invalid.length };
        if (valid.length === 0) {
          return {
            result: { result: { batchId: null, rows: total, started: [], invalid }, notices: [] },
            meta,
          };
        }
        // One start per valid row against the account's daily budget, all or nothing, before any credential exists.
        await charge(valid.length);
        const batchId = randomUUID();
        await repos.imports.insertBatch({
          id: batchId,
          accountId,
          createdBy: actor.userId,
          rows: total,
          createdAt: now,
        });
        const started: ImportBatchResult["started"] = [];
        const notices: ImportNotice[] = [];
        const also: AuditAlso[] = [];
        for (const v of valid) {
          let rowMint: { stalwartId: string; id: string } | null = null;
          try {
            const made = await createImport(
              repos,
              ctx,
              actor,
              accountId,
              v.mailbox,
              v.as,
              v.source,
              v.row.options,
              now,
              {
                batchId,
                onMint: (x) => {
                  rowMint = x;
                  minted.push(x);
                },
              },
            );
            started.push({ row: v.row.row, importId: made.row.id, address: made.fresh.address });
            if (made.notice) notices.push(made.notice);
            also.push({
              action: "data.import_started",
              target: { type: "mailbox", id: made.fresh.id, label: made.fresh.address },
              meta: { ...auditMeta(made.row), options: v.row.options, requestedAs: v.as, batchId },
            });
          } catch (err) {
            // A credential minted for this row whose import wasn't recorded comes off the mail server now (SA-66-04):
            // the batch goes on, so the request-wide clean-up below would never see it.
            const made = rowMint as { stalwartId: string; id: string } | null;
            if (made) {
              minted.splice(minted.indexOf(made), 1);
              await ctx.issuer.destroy(made.stalwartId, made.id).catch(() => undefined);
            }
            // Changed under the lock since the checks above: the row is reported, the others go ahead.
            if (err instanceof ImportRefusedError)
              invalid.push({
                row: v.row.row,
                code: err.reason === "import_running" ? "import_running" : "mailbox_unavailable",
              });
            else if (err instanceof NotFoundError) invalid.push({ row: v.row.row, code: "forbidden" });
            else throw err;
          }
        }
        invalid.sort((a, b) => a.row - b.row);
        return {
          result: { result: { batchId, rows: total, started, invalid }, notices },
          target: { id: batchId },
          meta: { rows: total, valid: started.length, invalid: invalid.length, batchId },
          also,
        };
      },
    );
    if (out === "act_as") throw new ForbiddenError("Imports can't be started while acting as someone.");
    if (out === "step_up_required") throw new StepUpRequiredError();
    return out;
  } catch (err) {
    // Credentials the mail server made for rows that weren't recorded (the whole unit of work rolled back).
    for (const m of minted) await ctx.issuer.destroy(m.stalwartId, m.id).catch(() => undefined);
    throw err;
  }
}

/** One batch and its imports the actor may see (`mailbox.import.any`); another account's batch id is 404. */
export async function getImportBatch(
  deps: Deps,
  actor: Actor,
  accountId: string,
  batchId: string,
): Promise<ImportBatchView> {
  authorize(actor, "mailbox.import.any", accountId);
  return deps.uow.run(async (r) => {
    const batch = isId(batchId) ? await r.imports.getBatch(accountId, batchId) : null;
    if (!batch) throw new NotFoundError();
    const mailboxes = new Map((await r.mailboxes.listByAccount(accountId)).map((m) => [m.id, m] as const));
    const imports: ImportView[] = [];
    for (const i of await r.imports.listBatch(accountId, batch.id)) {
      const m = mailboxes.get(i.mailboxId);
      if (m && (await accessTo(r, actor, accountId, m)) !== null) imports.push(view(i, m.address, actor));
    }
    return {
      id: batch.id,
      rows: batch.rows,
      createdAt: batch.createdAt,
      createdByYou: actor.kind === "user" && batch.createdBy === actor.userId,
      imports,
    };
  });
}

/** The batch's report as CSV (`mailbox, status, messages, duplicates, too_large, failed, error`), formula-safe. */
export function importBatchReport(batch: ImportBatchView): string {
  return toCsv([
    ["mailbox", "status", "messages", "duplicates", "too_large", "failed", "error"],
    ...batch.imports.map((i) => [
      i.address,
      i.status,
      String(i.messagesDone),
      String(i.duplicates),
      String(i.tooLarge),
      String(i.failed),
      i.blockedReason ?? i.errorCode ?? "",
    ]),
  ]);
}

/** True when the actor may run batches here (pages decide what to show; the service checks again). */
export const canBatchImport = (actor: Actor, accountId: string): boolean => can(actor, "mailbox.import.any", accountId);
