// SPDX-License-Identifier: AGPL-3.0-only
import { DATA_EXPORT } from "@anhourmail/shared/data-lifecycle";
import { customerDomainRecords } from "@anhourmail/shared/dns";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";

import { partialIp } from "../audit/labels";
import type { AuditEntry, AuditScope } from "../audit/types";
import type { Deps, Repositories } from "../ports";
import type { ExportFile } from "./entity";

/**
 * What goes into a data export (ADR-0025). Control-plane data only: never mail, contacts, passwords, app password or
 * mail-server secrets, sign-in codes, staff-only notes or full addresses of other people's devices. Each file is JSON
 * (complete) and, for the long lists, CSV (for spreadsheets; cells that start like a formula are prefixed with `'`).
 */

/** Page size when reading an audit log for an export. */
const AUDIT_PAGE = 1000;

/** Meta keys never copied out of an audit entry (staff-only notes; kept on the platform side). */
const HIDDEN_META = new Set(["internalNote"]);

/** A value as cell text (dates as ISO strings, objects as JSON). */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

/** One CSV cell: quoted when needed; a leading `=`, `+`, `-`, `@`, tab or CR is neutralised (CSV injection). */
export function csvCell(v: unknown): string {
  let s = cellText(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function csv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** An audit entry as exported: the network part of the address only, no user agent, no staff-only meta. */
export function exportedEntry(e: AuditEntry) {
  const meta = Object.fromEntries(Object.entries(e.meta).filter(([k]) => !HIDDEN_META.has(k)));
  return {
    seq: e.seq,
    at: e.at,
    action: e.action,
    result: e.result,
    errorCode: e.errorCode,
    actor: { type: e.actor.type, email: e.actor.email, role: e.actor.role },
    onBehalfOf: e.onBehalfOf ? { email: e.onBehalfOf.email } : null,
    target: e.target,
    ip: partialIp(e.ip),
    meta,
    prevHash: e.prevHash,
    hash: e.hash,
  };
}

function auditCsv(entries: readonly AuditEntry[]): string {
  return csv(
    [
      "seq",
      "at",
      "action",
      "result",
      "error_code",
      "actor_type",
      "actor_email",
      "actor_role",
      "on_behalf_of",
      "target_type",
      "target_id",
      "target_label",
      "ip",
    ],
    entries.map((e) => [
      e.seq,
      e.at,
      e.action,
      e.result,
      e.errorCode,
      e.actor.type,
      e.actor.email,
      e.actor.role,
      e.onBehalfOf?.email ?? null,
      e.target.type,
      e.target.id,
      e.target.label,
      partialIp(e.ip),
    ]),
  );
}

/** Newest first, up to `max` entries matching `filter`; `truncated` when older ones were left out. */
async function auditEntries(
  r: Repositories,
  scope: AuditScope,
  filter: { actorUserId?: string; targetId?: string },
  max: number,
): Promise<{ entries: AuditEntry[]; truncated: boolean }> {
  const out: AuditEntry[] = [];
  let before: number | undefined;
  while (out.length < max) {
    const page = await r.audit.list({
      scope,
      limit: Math.min(AUDIT_PAGE, max - out.length + 1),
      ...filter,
      ...(before !== undefined ? { beforeSeq: before } : {}),
    });
    out.push(...page);
    const last = page.at(-1);
    if (page.length === 0 || !last || last.seq <= 1) break;
    before = last.seq;
  }
  return { entries: out.slice(0, max), truncated: out.length > max };
}

const readme = (lines: readonly string[]) => `${lines.join("\n")}\n`;

/** The files of one account's export (`account.export`). */
export async function accountExportFiles(
  deps: Deps,
  r: Repositories,
  accountId: string,
  at: Date,
  maxAudit: number = DATA_EXPORT.maxAuditEntries,
): Promise<ExportFile[]> {
  const account = await r.accounts.get(accountId);
  if (!account) throw new Error("account not found");
  const [createdAt, policy, suspension, people, invites, domains, mailboxes, aliases] = [
    await r.dataLifecycle.accountCreatedAt(accountId),
    await r.security.accountPolicy(accountId),
    await r.suspensions.account(accountId),
    await r.people.list(accountId),
    await r.invites.listPending(accountId),
    await r.domains.listByAccount(accountId),
    await r.mailboxes.listByAccount(accountId),
    await r.aliases.listByAccount(accountId),
  ];
  const deletion = await r.dataLifecycle.getDeletion(accountId);
  const emailOf = new Map(people.map((p) => [p.userId, p.email]));
  const addressOf = new Map(mailboxes.map((m) => [m.id, m.address]));
  const domainRows = [];
  for (const d of domains) {
    const catchAll = await r.catchAll.get(d.id);
    domainRows.push({
      name: d.name,
      status: d.status,
      createdAt: d.createdAt,
      catchAllMailbox: catchAll ? (addressOf.get(catchAll) ?? null) : null,
      dkimKeys: d.dkimKeys ?? [],
      records: customerDomainRecords(d.name, d.verifyToken, deps.platform, d.dkimKeys).map((x) => ({
        purpose: x.purpose,
        type: x.type,
        name: x.name,
        value: x.value,
        ...(x.priority !== undefined ? { priority: x.priority } : {}),
        required: x.required,
      })),
    });
  }
  const appPasswords = [];
  for (const m of mailboxes) {
    for (const p of await r.appPasswords.listByMailbox(m.id)) {
      appPasswords.push({
        mailbox: m.address,
        name: p.name,
        protocols: p.protocols,
        status: p.status,
        createdAt: p.createdAt,
      });
    }
  }
  const audit = await auditEntries(r, `account:${accountId}`, {}, maxAudit);
  const mailboxRows = mailboxes.map((m) => ({
    address: m.address,
    person: m.userId ? (emailOf.get(m.userId) ?? null) : null,
    displayName: m.displayName ?? null,
    status: m.status,
    quotaBytes: m.quotaBytes,
    createdAt: m.createdAt,
    deleteAfter: m.purgeAfter,
  }));
  const aliasRows = aliases.map((a) => ({
    address: a.address,
    mailbox: addressOf.get(a.mailboxId) ?? null,
    kind: a.kind,
    enabled: a.enabled,
    description: a.description,
    createdAt: a.createdAt,
  }));
  return [
    {
      name: "README.txt",
      data: readme([
        "AnhourMail account export",
        "",
        `Account: ${account.name}`,
        `Created: ${at.toISOString()}`,
        "",
        "account.json        the account's settings and plan",
        "people.json / .csv  people, their roles, and pending invites",
        "domains.json        custom domains with the DNS records they need",
        "mailboxes.json/.csv mailboxes (settings only, no mail)",
        "aliases.json / .csv aliases and masked aliases",
        "app-passwords.json  app password names and protocols (never the passwords)",
        "audit-log.json/.csv the account's audit log, newest first; each entry keeps its hash so the chain can be checked",
        audit.truncated
          ? `                    (the ${String(maxAudit)} most recent entries; older ones stay readable in the console)`
          : "",
        "",
        "Mail and contacts aren't in this archive: each person exports their own from the webmail",
        "(Settings, Export), because we never copy mail out of the mail server.",
      ]),
    },
    {
      name: "account.json",
      data: json({
        id: accountId,
        name: account.name,
        plan: account.plan,
        status: account.status,
        createdAt,
        signInRequirement: policy,
        suspension: suspension ? { reason: suspension.reason, since: suspension.at } : null,
        deletion: deletion ? { requestedAt: deletion.requestedAt, deleteAfter: deletion.deleteAfter } : null,
      }),
    },
    {
      name: "people.json",
      data: json({
        people: people.map((p) => ({ name: p.name, email: p.email, role: p.role, joinedAt: p.joinedAt })),
        invites: invites.map((i) => ({ email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt })),
      }),
    },
    {
      name: "people.csv",
      data: csv(
        ["name", "email", "role", "joined_at"],
        people.map((p) => [p.name, p.email, ROLE_LABELS[`account:${p.role}`], p.joinedAt]),
      ),
    },
    { name: "domains.json", data: json(domainRows) },
    { name: "mailboxes.json", data: json(mailboxRows) },
    {
      name: "mailboxes.csv",
      data: csv(
        ["address", "person", "display_name", "status", "quota_bytes", "created_at"],
        mailboxRows.map((m) => [m.address, m.person, m.displayName, m.status, m.quotaBytes, m.createdAt]),
      ),
    },
    { name: "aliases.json", data: json(aliasRows) },
    {
      name: "aliases.csv",
      data: csv(
        ["address", "mailbox", "kind", "enabled", "description", "created_at"],
        aliasRows.map((a) => [a.address, a.mailbox, a.kind, a.enabled, a.description, a.createdAt]),
      ),
    },
    { name: "app-passwords.json", data: json(appPasswords) },
    { name: "audit-log.json", data: json(audit.entries.map(exportedEntry)) },
    { name: "audit-log.csv", data: auditCsv(audit.entries) },
  ].filter((f) => f.data !== "");
}

/** The files of a person's own export (`self.data.export`). */
export async function personalExportFiles(
  r: Repositories,
  userId: string,
  at: Date,
  maxAudit: number = DATA_EXPORT.maxAuditEntries,
): Promise<ExportFile[]> {
  const person = await r.dataLifecycle.person(userId);
  if (!person) throw new Error("person not found");
  const profile = await r.people.profile(userId);
  const memberships = await r.access.memberships(userId);
  const names = await r.access.accountNames(memberships.map((m) => m.accountId));
  // Only mailboxes in accounts they belong to now: a mailbox of an account they left (still linked to them until its
  // admins reassign it) is that account's data, not theirs.
  const current = new Set(memberships.map((m) => m.accountId));
  const mailboxes = (await r.suspensions.mailboxesOf(userId)).filter((m) => current.has(m.accountId));
  const own = [];
  for (const m of mailboxes) {
    const aliases = (await r.aliases.listByAccount(m.accountId)).filter((a) => a.mailboxId === m.id);
    const appPasswords = await r.appPasswords.listByMailbox(m.id);
    own.push({
      address: m.address,
      account: names[m.accountId] ?? null,
      displayName: m.displayName ?? null,
      status: m.status,
      quotaBytes: m.quotaBytes,
      createdAt: m.createdAt,
      aliases: aliases.map((a) => ({
        address: a.address,
        kind: a.kind,
        enabled: a.enabled,
        description: a.description,
        createdAt: a.createdAt,
      })),
      appPasswords: appPasswords.map((p) => ({ name: p.name, protocols: p.protocols, createdAt: p.createdAt })),
    });
  }
  const factors = await r.security.factors(userId);
  const sessions = await r.security.sessions(userId, at);
  const passkeys = await r.security.passkeys(userId);
  // Their own activity: what they did in their accounts, and their own sign-in and security events.
  const activity: AuditEntry[] = [];
  let truncated = false;
  const mine = await auditEntries(r, "platform", { actorUserId: userId, targetId: userId }, maxAudit);
  activity.push(...mine.entries);
  truncated ||= mine.truncated;
  for (const m of memberships) {
    const part = await auditEntries(r, `account:${m.accountId}`, { actorUserId: userId }, maxAudit);
    activity.push(...part.entries);
    truncated ||= part.truncated;
  }
  activity.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (activity.length > maxAudit) truncated = true;
  const kept = activity.slice(0, maxAudit);
  return [
    {
      name: "README.txt",
      data: readme([
        "AnhourMail personal data export",
        "",
        `Login: ${person.email}`,
        `Created: ${at.toISOString()}`,
        "",
        "profile.json       your name, sign-in address and optional profile details",
        "accounts.json      the accounts you belong to and your role in each",
        "mailboxes.json     your mailboxes' settings, aliases and app password names (no mail, no passwords)",
        "security.json      your sign-in factors and sessions (never codes, keys or passwords)",
        "activity.json/.csv what you did in the console and your sign-in events, newest first",
        truncated ? `                   (the ${String(maxAudit)} most recent entries)` : "",
        "",
        "Mail and contacts aren't in this archive: export them from the webmail (Settings, Export).",
      ]),
    },
    {
      name: "profile.json",
      data: json({
        name: person.name,
        firstName: person.firstName,
        lastName: person.lastName,
        email: person.email,
        emailConfirmed: person.emailVerified,
        createdAt: person.createdAt,
        details: profile,
      }),
    },
    {
      name: "accounts.json",
      data: json(memberships.map((m) => ({ id: m.accountId, name: names[m.accountId] ?? null, role: m.role }))),
    },
    { name: "mailboxes.json", data: json(own) },
    {
      name: "security.json",
      data: json({
        authenticatorApp: factors.totp,
        recoveryCodesLeft: factors.recoveryCodesLeft,
        passkeys: passkeys.map((p) => ({ name: p.name, createdAt: p.createdAt, deviceType: p.deviceType })),
        // The network part of the address, as the Security page and the audit views show it; the person's own browser
        // and system string is kept.
        sessions: sessions.map((s) => ({
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          expiresAt: s.expiresAt,
          ip: partialIp(s.ip),
          userAgent: s.userAgent,
        })),
      }),
    },
    { name: "activity.json", data: json(kept.map(exportedEntry)) },
    { name: "activity.csv", data: auditCsv(kept) },
  ].filter((f) => f.data !== "");
}
