// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Starting and controlling mail imports (ADR-0030 §1, §6, §13–§15). Every service takes the actor and checks
 * permission and scope itself: `mailbox.import.own` for the person's own mailboxes, `mailbox.import.any` for any
 * mailbox in the account (an Owner's or admin's mailbox: Owners only, the `mailbox.manage` rule). Starting and resuming
 * mint the destination credential with the web app's operations key (`ImportCredentialIssuer`), so they need a fresh
 * step-up and are never allowed while staff act as someone. Secrets are sealed before they are written and never
 * returned, logged or audited; audit metadata is ids, host and port, options, counts and codes only (rule 24, 48).
 */
import { randomUUID } from "node:crypto";

import type { DevAllowList } from "@anhourmail/server/net-guard";
import { IMPORT, type ImportBlockedReason, isTerminalImportStatus } from "@anhourmail/shared/import";
import { accountRoleCan } from "@anhourmail/shared/rbac";

import { type Actor, authorize, can, type UserActor } from "../actor";
import { ForbiddenError, NotFoundError, StepUpRequiredError } from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import { lifecycleLocked } from "../mailboxes/service";
import { mutation, type MutationOutcome } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import {
  finishedSourceHost,
  type MailImport,
  type MailImportFolder,
  type MailImportOptions,
  importOptions,
} from "./entity";
import { ImportRefusedError } from "./errors";
import { endImport } from "./lifecycle";
import type { ImportCredentialIssuer } from "./ports";
import { type ImportSealer, openFolderPath, sealDestinationSecret, sealSourceSecret } from "./secrets";
import { importSource, importSourceSecret } from "./source";

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const DAY = 86_400_000;
/** Resume mints a new destination credential when the current one has less than this left. */
export const RENEW_CREDENTIAL_WITHIN_MS = DAY;
/** How many imports the console lists at once. */
export const IMPORT_LIST_LIMIT = 100;

/** What the console sees of one import: never a secret, the source username or the mail server's ids. */
export type ImportView = {
  id: string;
  mailboxId: string;
  address: string;
  /** The admins' CSV batch it was started from, or null. */
  batchId: string | null;
  requestedAs: "own" | "admin";
  /** The viewer started it (an admin-started import into someone's mailbox shows false to that person). */
  startedByYou: boolean;
  sourceHost: string;
  sourcePort: number;
  options: MailImportOptions;
  status: MailImport["status"];
  phase: MailImport["phase"];
  blockedReason: ImportBlockedReason | null;
  errorCode: string | null;
  pauseRequested: boolean;
  foldersTotal: number;
  messagesTotal: number;
  bytesTotal: number;
  messagesDone: number;
  bytesDone: number;
  duplicates: number;
  tooLarge: number;
  failed: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  syncUntil: Date | null;
  credentialExpiresAt: Date | null;
};

/** One source folder's progress: its role and counts; its name only while the import runs (sealed, opened here). */
export type ImportFolderView = {
  id: string;
  role: MailImportFolder["role"];
  name: string | null;
  status: MailImportFolder["status"];
  messagesTotal: number;
  messagesDone: number;
  duplicates: number;
  tooLarge: number;
  failed: number;
};

export type ImportDetail = ImportView & {
  folders: ImportFolderView[];
  /**
   * The mailbox's domain is one of the account's own and active (MX verified): mail for it now arrives here, so a
   * syncing import can be stopped (ADR-0030 §7). False for the platform's free addresses.
   */
  domainActive: boolean;
};

/** What the app wires in: the operations-key issuer, the key ring, and (development only) the sources allowed in. */
export type ImportContext = {
  issuer: ImportCredentialIssuer;
  sealer: ImportSealer;
  devSources?: DevAllowList;
  /** Outside production: only `devSources` may be imported from (never a real provider). */
  devSourcesOnly?: boolean;
};

/** The admin-started notice the route emails to the mailbox's person (rule 49 in spirit). */
export type ImportNotice = { to: string; address: string; startedBy: string; sourceHost: string; at: Date };

const ownedBy = (actor: Actor, m: Pick<Mailbox, "userId">): boolean =>
  actor.kind === "user" && m.userId !== null && m.userId === actor.userId;

export type Access = "own" | "admin" | null;

/** How the actor may act on this mailbox's imports: as its person, as an admin with `.any`, or not at all. */
export async function accessTo(repos: Repositories, actor: Actor, accountId: string, m: Mailbox): Promise<Access> {
  if (ownedBy(actor, m) && can(actor, "mailbox.import.own", accountId)) return "own";
  if (!can(actor, "mailbox.import.any", accountId)) return null;
  return lifecycleLocked(actor, accountId, m, await repos.access.members(accountId)) ? null : "admin";
}

export function view(i: MailImport, address: string, actor: Actor): ImportView {
  return {
    id: i.id,
    mailboxId: i.mailboxId,
    address,
    batchId: i.batchId,
    requestedAs: i.requestedAs,
    startedByYou: actor.kind === "user" && i.requestedBy === actor.userId,
    sourceHost: i.sourceHost,
    sourcePort: i.sourcePort,
    options: i.options,
    status: i.status,
    phase: i.phase,
    blockedReason: i.blockedReason,
    errorCode: i.errorCode,
    pauseRequested: i.pauseRequested,
    foldersTotal: i.foldersTotal,
    messagesTotal: i.messagesTotal,
    bytesTotal: i.bytesTotal,
    messagesDone: i.messagesDone,
    bytesDone: i.bytesDone,
    duplicates: i.duplicates,
    tooLarge: i.tooLarge,
    failed: i.failed,
    createdAt: i.createdAt,
    startedAt: i.startedAt,
    finishedAt: i.finishedAt,
    syncUntil: i.syncUntil,
    credentialExpiresAt: i.destinationCredentialExpiresAt,
  };
}

/**
 * Audit metadata of an import: ids, the source's registrable domain (`finishedSourceHost`; the full host name is a
 * redacted log key, and finished history keeps only the domain too) and port. Never the username or a secret.
 */
export const auditMeta = (i: Pick<MailImport, "id" | "mailboxId" | "sourceHost" | "sourcePort">) => ({
  importId: i.id,
  mailboxId: i.mailboxId,
  sourceDomain: finishedSourceHost(i.sourceHost),
  sourcePort: i.sourcePort,
});

/** Mailbox states an import can write into (ADR-0030 §13): active, on the mail server, no first-sign-in change owed. */
export const mailboxImportable = (m: Mailbox): boolean =>
  m.status === "active" && m.stalwartId !== null && m.mustChangePassword !== true;

const credentialExpiry = (now: Date, sync: boolean) =>
  new Date(now.getTime() + (sync ? IMPORT.syncWindowDays : IMPORT.credentialDays) * DAY);

type StartInput = {
  mailboxId?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
  options?: unknown;
};

type Refusal = "act_as" | "forbidden" | "step_up_required";

function refusal(code: Refusal): never {
  if (code === "step_up_required") throw new StepUpRequiredError();
  if (code === "act_as") throw new ForbiddenError("Imports can't be started or resumed while acting as someone.");
  throw new ForbiddenError("You can import only into your own mailboxes.");
}

/**
 * Re-reads the mailbox and the actor's role under the account and credential locks (a person removed meanwhile, or a
 * mailbox handed over, gets nothing), then checks the mailbox can take an import. Returns the fresh mailbox.
 */
async function lockedMailbox(
  repos: Repositories,
  actor: UserActor,
  accountId: string,
  m: Mailbox,
  as: "own" | "admin",
): Promise<Mailbox & { stalwartId: string }> {
  await repos.accounts.lock(accountId);
  await repos.appPasswords.lockCredentials(m.id);
  const members = await repos.access.members(accountId);
  const role = members.find((x) => x.userId === actor.userId)?.role;
  const fresh = await repos.mailboxes.get(accountId, m.id);
  const allowed =
    role !== undefined &&
    fresh !== null &&
    (as === "own"
      ? accountRoleCan(role, "mailbox.import.own") && ownedBy(actor, fresh)
      : accountRoleCan(role, "mailbox.import.any") &&
        // Read again too: the mailbox's person may have become an admin (then Owners only).
        (role === "owner" || !lifecycleLocked(actor, accountId, fresh, members)));
  if (!allowed) throw new NotFoundError();
  if (!mailboxImportable(fresh) || fresh.stalwartId === null) throw new ImportRefusedError("mailbox_unavailable");
  return { ...fresh, stalwartId: fresh.stalwartId };
}

/**
 * The part of a start that writes (shared by `startImport` and the admins' batch): under the account and credential
 * locks re-reads the mailbox and the actor's role, refuses a second live import (409 `import_running`), mints the
 * IMAP-only destination credential (reported through `onMint` at once, so a later failure can destroy it), seals both
 * secrets and records the import (`queued`). Returns the row, the fresh mailbox and, for an admin starting one into
 * someone else's mailbox, the notice to email that person.
 */
export async function createImport(
  repos: Repositories,
  ctx: ImportContext,
  actor: UserActor,
  accountId: string,
  m: Mailbox,
  as: "own" | "admin",
  source: { host: string; port: MailImport["sourcePort"]; username: string; secret: string },
  options: MailImportOptions,
  now: Date,
  opts: { batchId: string | null; onMint: (minted: { stalwartId: string; id: string }) => void },
): Promise<{ row: MailImport; fresh: Mailbox & { stalwartId: string }; notice: ImportNotice | null }> {
  const fresh = await lockedMailbox(repos, actor, accountId, m, as);
  if (await repos.imports.activeForMailbox(fresh.id)) throw new ImportRefusedError("import_running");
  const id = randomUUID();
  const expiresAt = credentialExpiry(now, options.sync);
  const credential = await ctx.issuer.mint(fresh.stalwartId, expiresAt);
  opts.onMint({ stalwartId: fresh.stalwartId, id: credential.id });
  const inserted = await repos.imports.insert({
    id,
    accountId,
    mailboxId: fresh.id,
    batchId: opts.batchId,
    requestedBy: actor.userId,
    requestedAs: as,
    sourceKind: "imap_password",
    sourceHost: source.host,
    sourcePort: source.port,
    sourceUsername: source.username,
    sourceSecret: sealSourceSecret(ctx.sealer, id, source.secret),
    destinationSecret: sealDestinationSecret(ctx.sealer, id, credential.secret),
    destinationCredentialId: credential.id,
    destinationCredentialCreatedAt: credential.createdAt,
    destinationCredentialExpiresAt: expiresAt,
    options,
    syncUntil: options.sync ? new Date(now.getTime() + IMPORT.syncWindowDays * DAY) : null,
    createdAt: now,
    runAfter: now,
  });
  if (inserted === "import_running") throw new ImportRefusedError("import_running");
  const row = await repos.imports.get(accountId, id);
  if (!row) throw new NotFoundError();
  const person =
    as === "admin" && fresh.userId !== null && fresh.userId !== actor.userId
      ? (await repos.access.members(accountId)).find((x) => x.userId === fresh.userId)
      : undefined;
  return {
    row,
    fresh,
    notice: person
      ? { to: person.email, address: fresh.address, startedBy: actor.email, sourceHost: source.host, at: now }
      : null,
  };
}

/**
 * Starts an import into one of the account's mailboxes (ADR-0030 §1–§2, §13): checks the source, needs a fresh
 * step-up on this console session, mints the IMAP-only destination credential under the mailbox's credential lock,
 * seals both secrets and records the import (`queued`) for the importer. One live import per mailbox (409
 * `import_running`); a mailbox that isn't active, is suspended or deleting, or owes its first password change is 409
 * `mailbox_unavailable`. Never while acting as someone (403). If anything after the mint fails, the credential is
 * destroyed again. Audited `data.import_started` (host, port, options; never the username or a secret).
 */
export async function startImport(
  deps: Deps,
  ctx: ImportContext,
  actor: Actor,
  accountId: string,
  input: StartInput,
  session: { sessionId: string | null },
  req: RequestMeta,
): Promise<{ import: ImportView; notice: ImportNotice | null }> {
  const mailboxId = typeof input.mailboxId === "string" ? input.mailboxId : "";
  let minted: { stalwartId: string; id: string } | null = null;
  try {
    const out = await mutation(
      deps,
      actor,
      req,
      {
        action: "data.import_started",
        permission: "mailbox.import.own",
        accountId,
        target: { type: "mailbox", id: isId(mailboxId) ? mailboxId : null },
      },
      async (repos): Promise<MutationOutcome<{ import: ImportView; notice: ImportNotice | null } | Refusal>> => {
        if (actor.kind !== "user") throw new ForbiddenError();
        const refuse = (code: Refusal, label?: string) => ({
          result: code,
          ...(label === undefined ? {} : { target: { label } }),
          denied: { code },
        });
        if (actor.actingAs) return refuse("act_as");
        const m = isId(mailboxId) ? await repos.mailboxes.get(accountId, mailboxId) : null;
        if (!m) throw new NotFoundError();
        const as = await accessTo(repos, actor, accountId, m);
        if (as === null) {
          // Someone who can see mailboxes knows this one exists: 403. Anyone else: it doesn't exist for them.
          if (!can(actor, "mailbox.read", accountId)) throw new NotFoundError();
          return refuse("forbidden", m.address);
        }
        const source = importSource(input, ctx.devSources, { allowListOnly: ctx.devSourcesOnly === true });
        const options = importOptions(input.options);
        const now = deps.clock.now();
        if (!session.sessionId || !(await repos.security.stepUpFresh(actor.userId, session.sessionId, now))) {
          return refuse("step_up_required", m.address);
        }
        const { row, fresh, notice } = await createImport(repos, ctx, actor, accountId, m, as, source, options, now, {
          batchId: null,
          onMint: (made) => {
            minted = made;
          },
        });
        return {
          result: { import: view(row, fresh.address, actor), notice },
          target: { id: fresh.id, label: fresh.address },
          meta: { ...auditMeta(row), options, requestedAs: as },
        };
      },
    );
    if (typeof out === "string") refusal(out);
    return out;
  } catch (err) {
    // The mail server made the credential but the import wasn't recorded: take it off again, so no credential exists
    // that nothing will ever revoke.
    const made = minted as { stalwartId: string; id: string } | null;
    if (made) await ctx.issuer.destroy(made.stalwartId, made.id).catch(() => undefined);
    throw err;
  }
}

/** The import and its mailbox, scoped to the account and to what the actor may see (404 otherwise). */
async function scopedImport(
  repos: Repositories,
  actor: Actor,
  accountId: string,
  importId: string,
): Promise<{ row: MailImport; mailbox: Mailbox; as: "own" | "admin" }> {
  const row = isId(importId) ? await repos.imports.get(accountId, importId) : null;
  const mailbox = row ? await repos.mailboxes.get(accountId, row.mailboxId) : null;
  if (!row || !mailbox) throw new NotFoundError();
  const as = await accessTo(repos, actor, accountId, mailbox);
  if (as === null) throw new NotFoundError();
  return { row, mailbox, as };
}

/** The account's imports the actor may see: their own mailboxes', or every mailbox's with `mailbox.import.any`. */
export async function listImports(deps: Deps, actor: Actor, accountId: string): Promise<ImportView[]> {
  authorize(actor, "mailbox.import.own", accountId);
  return deps.uow.run(async (r) => {
    const mailboxes = await r.mailboxes.listByAccount(accountId);
    const visible: Mailbox[] = [];
    for (const m of mailboxes) if ((await accessTo(r, actor, accountId, m)) !== null) visible.push(m);
    const address = new Map(visible.map((m) => [m.id, m.address] as const));
    const rows = await r.imports.list(accountId, {
      mailboxIds: visible.map((m) => m.id),
      limit: IMPORT_LIST_LIMIT,
    });
    return rows.map((i) => view(i, address.get(i.mailboxId) ?? "", actor));
  });
}

/** A mailbox the "New import" form offers, with why it can't take one right now (null: it can). */
export type ImportTarget = {
  mailboxId: string;
  address: string;
  as: "own" | "admin";
  /** Someone else's mailbox with a person (who is emailed when an admin starts one); false for shared ones. */
  hasPerson: boolean;
  unavailable: "mailbox_unavailable" | "import_running" | null;
};

/**
 * The mailboxes the actor may import into (their own with `mailbox.import.own`; any they may manage with
 * `mailbox.import.any`), own ones first, each with the reason it can't take an import now. Also whether the actor may
 * run the admins' CSV batch.
 */
export async function importTargets(
  deps: Deps,
  actor: Actor,
  accountId: string,
): Promise<{ targets: ImportTarget[]; canBatch: boolean }> {
  authorize(actor, "mailbox.import.own", accountId);
  return deps.uow.run(async (r) => {
    const targets: ImportTarget[] = [];
    for (const m of await r.mailboxes.listByAccount(accountId)) {
      if (m.status === "deleting") continue;
      const as = await accessTo(r, actor, accountId, m);
      if (as === null) continue;
      const unavailable = !mailboxImportable(m)
        ? "mailbox_unavailable"
        : (await r.imports.activeForMailbox(m.id))
          ? "import_running"
          : null;
      targets.push({ mailboxId: m.id, address: m.address, as, hasPerson: m.userId !== null, unavailable });
    }
    targets.sort((a, b) => (a.as === b.as ? a.address.localeCompare(b.address) : a.as === "own" ? -1 : 1));
    return { targets, canBatch: can(actor, "mailbox.import.any", accountId) };
  });
}

/** One import with its folders (names only while it runs). Another account's, or one the actor can't see, is 404. */
export async function getImport(
  deps: Deps,
  sealer: ImportSealer,
  actor: Actor,
  accountId: string,
  importId: string,
): Promise<ImportDetail> {
  authorize(actor, "mailbox.import.own", accountId);
  return deps.uow.run(async (r) => {
    const { row, mailbox } = await scopedImport(r, actor, accountId, importId);
    const folders = await r.imports.folders(row.id);
    const domain = mailbox.address.slice(mailbox.address.lastIndexOf("@") + 1).toLowerCase();
    const domainActive = (await r.domains.listByAccount(accountId)).some(
      (d) => d.name.toLowerCase() === domain && d.status === "active",
    );
    return {
      ...view(row, mailbox.address, actor),
      domainActive,
      folders: folders.map((f) => {
        let name: string | null = null;
        if (f.sourcePath !== null && !isTerminalImportStatus(row.status)) {
          try {
            name = openFolderPath(sealer, row.id, f.id, f.sourcePath);
          } catch {
            name = null; // a key that can't open it: shown by role only
          }
        }
        return {
          id: f.id,
          role: f.role,
          name,
          status: f.status,
          messagesTotal: f.messagesTotal,
          messagesDone: f.messagesDone,
          duplicates: f.duplicates,
          tooLarge: f.tooLarge,
          failed: f.failed,
        };
      }),
    };
  });
}

/** A live import of the actor's, for a control action (404 out of scope, 409 once it has finished). */
async function liveImport(
  repos: Repositories,
  actor: Actor,
  accountId: string,
  importId: string,
): Promise<{ row: MailImport; mailbox: Mailbox; as: "own" | "admin" }> {
  const found = await scopedImport(repos, actor, accountId, importId);
  if (isTerminalImportStatus(found.row.status)) throw new ImportRefusedError("import_finished");
  return found;
}

const leased = (i: MailImport, now: Date) => i.leaseUntil !== null && i.leaseUntil.getTime() > now.getTime();

/**
 * Pauses an import (ADR-0030 §6): a running one stops at the next message boundary (the importer sets `paused`); one
 * that isn't running now is paused at once. Credentials are kept until the destination credential expires. Same
 * permission as starting, no step-up (the safe direction). Audited `data.import_paused`.
 */
export async function pauseImport(
  deps: Deps,
  actor: Actor,
  accountId: string,
  importId: string,
  req: RequestMeta,
): Promise<ImportView> {
  return mutation(
    deps,
    actor,
    req,
    {
      action: "data.import_paused",
      permission: "mailbox.import.own",
      accountId,
      target: { type: "mail_import", id: isId(importId) ? importId : null },
    },
    async (repos) => {
      const { row, mailbox } = await liveImport(repos, actor, accountId, importId);
      const now = deps.clock.now();
      const updated =
        row.status === "paused"
          ? row
          : await repos.imports.update(
              row.id,
              leased(row, now) ? { pauseRequested: true } : { status: "paused", pauseRequested: false },
            );
      if (!updated) throw new ImportRefusedError("import_finished");
      return {
        result: view(updated, mailbox.address, actor),
        target: { id: row.id, label: mailbox.address },
        meta: { ...auditMeta(row), immediate: !leased(row, now) },
      };
    },
  );
}

/**
 * Resumes a paused or blocked import (ADR-0030 §6, §19): optionally with a new source password (the fix for a refused
 * sign-in), and with a new destination credential when the current one expires within a day (the old one's revoke is
 * queued). Needs a fresh step-up (it may mint) and is refused while acting as someone. Audited `data.import_resumed`
 * (meta `credentialRenewed`, `sourcePasswordChanged`).
 */
export async function resumeImport(
  deps: Deps,
  ctx: ImportContext,
  actor: Actor,
  accountId: string,
  importId: string,
  input: { password?: unknown },
  session: { sessionId: string | null },
  req: RequestMeta,
): Promise<ImportView> {
  let minted: { stalwartId: string; id: string } | null = null;
  try {
    const out = await mutation(
      deps,
      actor,
      req,
      {
        action: "data.import_resumed",
        permission: "mailbox.import.own",
        accountId,
        target: { type: "mail_import", id: isId(importId) ? importId : null },
      },
      async (repos): Promise<MutationOutcome<ImportView | Refusal>> => {
        if (actor.kind !== "user") throw new ForbiddenError();
        if (actor.actingAs) return { result: "act_as", denied: { code: "act_as" } };
        const { row, mailbox, as } = await liveImport(repos, actor, accountId, importId);
        if (row.status !== "paused" && row.status !== "blocked") {
          // Already queued, running or syncing: nothing to resume (a pause asked for is withdrawn).
          const same = row.pauseRequested ? await repos.imports.update(row.id, { pauseRequested: false }) : row;
          return {
            result: view(same ?? row, mailbox.address, actor),
            target: { id: row.id, label: mailbox.address },
            meta: { ...auditMeta(row), alreadyRunning: true },
          };
        }
        const secret =
          input.password === undefined || input.password === null || input.password === ""
            ? null
            : importSourceSecret(input.password);
        const now = deps.clock.now();
        if (!session.sessionId || !(await repos.security.stepUpFresh(actor.userId, session.sessionId, now))) {
          return {
            result: "step_up_required",
            target: { label: mailbox.address },
            denied: { code: "step_up_required" },
          };
        }
        const fresh = await lockedMailbox(repos, actor, accountId, mailbox, as);
        const expires = row.destinationCredentialExpiresAt?.getTime() ?? 0;
        const renew =
          row.destinationSecret === null ||
          row.blockedReason === "destination_credential" ||
          expires - now.getTime() < RENEW_CREDENTIAL_WITHIN_MS;
        const patch: Parameters<Repositories["imports"]["update"]>[1] = {
          status: "queued",
          phase: null,
          blockedReason: null,
          errorCode: null,
          pauseRequested: false,
          attempts: 0,
          runAfter: now,
        };
        if (secret !== null) patch.sourceSecret = sealSourceSecret(ctx.sealer, row.id, secret);
        if (renew) {
          // A sync window still running keeps its end; the credential never outlives it by more than its own life.
          const until = row.syncUntil && row.syncUntil.getTime() > now.getTime() ? row.syncUntil : null;
          const expiresAt = until ?? credentialExpiry(now, false);
          const credential = await ctx.issuer.mint(fresh.stalwartId, expiresAt);
          minted = { stalwartId: fresh.stalwartId, id: credential.id };
          patch.destinationSecret = sealDestinationSecret(ctx.sealer, row.id, credential.secret);
          patch.destinationCredentialId = credential.id;
          patch.destinationCredentialCreatedAt = credential.createdAt;
          patch.destinationCredentialExpiresAt = expiresAt;
        }
        const updated = await repos.imports.update(row.id, patch);
        if (!updated) throw new ImportRefusedError("import_finished");
        // The replaced credential comes off the mail server through the normal job (it keeps the live one).
        if (renew && row.destinationCredentialId !== null) {
          await repos.provisioning.enqueue({ kind: "mail_import.credential_revoke", subjectId: row.id, runAfter: now });
        }
        return {
          result: view(updated, fresh.address, actor),
          target: { id: row.id, label: fresh.address },
          meta: { ...auditMeta(row), credentialRenewed: renew, sourcePasswordChanged: secret !== null },
        };
      },
    );
    if (typeof out === "string") refusal(out);
    return out;
  } catch (err) {
    const made = minted as { stalwartId: string; id: string } | null;
    if (made) await ctx.issuer.destroy(made.stalwartId, made.id).catch(() => undefined);
    throw err;
  }
}

/**
 * Cancels an import at once (ADR-0030 §6): `cancelled`, both secrets and the source username wiped and the credential's
 * revoke queued in this request, before the importer notices (it can't renew its lease or write progress any more).
 * Same permission as starting, no step-up. Audited `data.import_cancelled` (reason `person`).
 */
export async function cancelImport(
  deps: Deps,
  actor: Actor,
  accountId: string,
  importId: string,
  req: RequestMeta,
): Promise<ImportView> {
  return mutation(
    deps,
    actor,
    req,
    {
      action: "data.import_cancelled",
      permission: "mailbox.import.own",
      accountId,
      target: { type: "mail_import", id: isId(importId) ? importId : null },
    },
    async (repos) => {
      const { row, mailbox } = await liveImport(repos, actor, accountId, importId);
      const ended = await endImport(repos, row.id, { status: "cancelled", at: deps.clock.now() });
      if (!ended) throw new ImportRefusedError("import_finished");
      return {
        result: view(ended, mailbox.address, actor),
        target: { id: row.id, label: mailbox.address },
        meta: { ...auditMeta(row), reason: "person", messagesDone: ended.messagesDone },
      };
    },
  );
}

/**
 * Stops cut-over sync (ADR-0030 §7): the sync window ends now, so the importer runs one last pass and then completes
 * the import (and wipes it). Only for an import that syncs. Audited `data.import_sync_stopped` (reason `person`).
 */
export async function stopImportSync(
  deps: Deps,
  actor: Actor,
  accountId: string,
  importId: string,
  req: RequestMeta,
): Promise<ImportView> {
  return mutation(
    deps,
    actor,
    req,
    {
      action: "data.import_sync_stopped",
      permission: "mailbox.import.own",
      accountId,
      target: { type: "mail_import", id: isId(importId) ? importId : null },
    },
    async (repos) => {
      const { row, mailbox } = await liveImport(repos, actor, accountId, importId);
      if (!row.options.sync) throw new ImportRefusedError("import_finished");
      const now = deps.clock.now();
      const updated = await repos.imports.update(row.id, {
        syncUntil: now,
        ...(row.status === "syncing" ? { runAfter: now } : {}),
      });
      if (!updated) throw new ImportRefusedError("import_finished");
      return {
        result: view(updated, mailbox.address, actor),
        target: { id: row.id, label: mailbox.address },
        meta: { ...auditMeta(row), reason: "person" },
      };
    },
  );
}
