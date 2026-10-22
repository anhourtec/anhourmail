// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import type { AppPassword, AppPasswordRepository } from "@anhourmail/core/app-passwords";
import type { CatchAllRepository } from "@anhourmail/core/domains";
import { type AppPasswordProtocol, isAppPasswordProtocol } from "@anhourmail/shared/security";

import type { Executor } from "./client";
import { appPassword, customerDomain, mailbox, provisioningJob } from "./schema";

const isId = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

const toAppPassword = (r: typeof appPassword.$inferSelect): AppPassword => ({
  id: r.id,
  accountId: r.accountId,
  mailboxId: r.mailboxId,
  name: r.name,
  protocols: r.protocols.filter((p): p is AppPasswordProtocol => isAppPasswordProtocol(p)),
  credentialId: r.credentialId,
  credentialCreatedAt: r.credentialCreatedAt,
  createdAt: r.createdAt,
  createdBy: r.createdBy,
  status: r.status === "revoking" ? "revoking" : "active",
});

/** App password metadata (never a secret: the mail server holds it hashed). */
export class PgAppPasswordRepository implements AppPasswordRepository {
  constructor(private readonly x: Executor) {}

  async listByMailbox(mailboxId: string): Promise<AppPassword[]> {
    if (!isId(mailboxId)) return [];
    const rows = await this.x
      .select()
      .from(appPassword)
      .where(eq(appPassword.mailboxId, mailboxId))
      .orderBy(desc(appPassword.createdAt), appPassword.id);
    return rows.map(toAppPassword);
  }

  async get(mailboxId: string, id: string): Promise<AppPassword | null> {
    if (!isId(mailboxId) || !isId(id)) return null;
    const [r] = await this.x
      .select()
      .from(appPassword)
      .where(and(eq(appPassword.mailboxId, mailboxId), eq(appPassword.id, id)));
    return r ? toAppPassword(r) : null;
  }

  async insert(p: AppPassword): Promise<void> {
    await this.x.insert(appPassword).values({
      id: p.id,
      accountId: p.accountId,
      mailboxId: p.mailboxId,
      name: p.name,
      protocols: [...p.protocols],
      credentialId: p.credentialId,
      credentialCreatedAt: p.credentialCreatedAt,
      status: p.status,
      createdBy: p.createdBy,
      createdAt: p.createdAt,
    });
  }

  async markRevoking(mailboxId: string, id: string | null): Promise<AppPassword[]> {
    if (!isId(mailboxId) || (id !== null && !isId(id))) return [];
    const rows = await this.x
      .update(appPassword)
      .set({ status: "revoking" })
      .where(
        and(
          eq(appPassword.mailboxId, mailboxId),
          eq(appPassword.status, "active"),
          ...(id === null ? [] : [eq(appPassword.id, id)]),
        ),
      )
      .returning();
    return rows.map(toAppPassword);
  }

  async revoking(mailboxId: string): Promise<AppPassword[]> {
    if (!isId(mailboxId)) return [];
    const rows = await this.x
      .select()
      .from(appPassword)
      .where(and(eq(appPassword.mailboxId, mailboxId), eq(appPassword.status, "revoking")))
      .orderBy(appPassword.createdAt);
    return rows.map(toAppPassword);
  }

  async deleteRevoked(id: string): Promise<void> {
    if (!isId(id)) return;
    await this.x.delete(appPassword).where(and(eq(appPassword.id, id), eq(appPassword.status, "revoking")));
  }

  async mailboxesWithRevoking(): Promise<{ mailboxId: string; jobOpen: boolean }[]> {
    const rows = await this.x
      .selectDistinct({ mailboxId: appPassword.mailboxId })
      .from(appPassword)
      .where(eq(appPassword.status, "revoking"));
    if (rows.length === 0) return [];
    const open = await this.x
      .selectDistinct({ subjectId: provisioningJob.subjectId })
      .from(provisioningJob)
      .where(
        and(
          eq(provisioningJob.kind, "app_password.revoke"),
          inArray(provisioningJob.status, ["queued", "running"]),
          inArray(
            provisioningJob.subjectId,
            rows.map((r) => r.mailboxId),
          ),
        ),
      );
    const busy = new Set(open.map((o) => o.subjectId));
    return rows.map((r) => ({ mailboxId: r.mailboxId, jobOpen: busy.has(r.mailboxId) }));
  }

  async mailboxesOnServer(): Promise<
    { id: string; accountId: string; address: string; stalwartId: string; status: string }[]
  > {
    const rows = await this.x
      .select({
        id: mailbox.id,
        accountId: mailbox.accountId,
        address: mailbox.address,
        stalwartId: mailbox.stalwartId,
        status: mailbox.status,
      })
      .from(mailbox)
      .where(isNotNull(mailbox.stalwartId));
    return rows.flatMap((r) => (r.stalwartId === null ? [] : [{ ...r, stalwartId: r.stalwartId }]));
  }
}

/** Catch-all per customer domain (`customer_domain.catch_all_mailbox_id`). */
export class PgCatchAllRepository implements CatchAllRepository {
  constructor(private readonly x: Executor) {}

  async get(domainId: string): Promise<string | null> {
    if (!isId(domainId)) return null;
    const [r] = await this.x
      .select({ mailboxId: customerDomain.catchAllMailboxId })
      .from(customerDomain)
      .where(eq(customerDomain.id, domainId));
    return r?.mailboxId ?? null;
  }

  async set(domainId: string, mailboxId: string | null): Promise<void> {
    if (!isId(domainId)) return;
    await this.x.update(customerDomain).set({ catchAllMailboxId: mailboxId }).where(eq(customerDomain.id, domainId));
  }

  async clearForMailbox(mailboxId: string): Promise<{ id: string; name: string }[]> {
    if (!isId(mailboxId)) return [];
    const rows = await this.x
      .update(customerDomain)
      .set({ catchAllMailboxId: null })
      .where(eq(customerDomain.catchAllMailboxId, mailboxId))
      .returning({ id: customerDomain.id, name: customerDomain.name });
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async targetAddress(domainId: string): Promise<string | null> {
    if (!isId(domainId)) return null;
    const [r] = await this.x
      .select({ address: mailbox.address })
      .from(customerDomain)
      // Same account as the domain, always (the service already checks; this keeps a stray row from routing mail
      // for one account's domain into another account's mailbox).
      .innerJoin(
        mailbox,
        and(eq(mailbox.id, customerDomain.catchAllMailboxId), eq(mailbox.accountId, customerDomain.accountId)),
      )
      .where(and(eq(customerDomain.id, domainId), eq(mailbox.status, "active")));
    return r?.address ?? null;
  }
}
