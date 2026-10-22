// SPDX-License-Identifier: AGPL-3.0-only
import { type Actor, can, type Deps } from "@anhourmail/core";
import { listAliases } from "@anhourmail/core/aliases";
import { listDomains } from "@anhourmail/core/domains";
import { listMailboxes } from "@anhourmail/core/mailboxes";
import { listPeople } from "@anhourmail/core/people";
import { searchAccounts } from "@anhourmail/core/platform";

/**
 * The console's global search (app bar). It only reads through the core services, which check permission and
 * account scope themselves; each source is asked only when the actor holds its permission in that account, so a
 * search never reaches another account's data and never turns into a 403. Metadata only: addresses, names and
 * domain names — nothing here touches mail content.
 */

export type SearchKind = "mailbox" | "alias" | "domain" | "person" | "account";

export type SearchHit = {
  kind: SearchKind;
  id: string;
  /** The thing itself: an address, a domain, a person's name, an account name. */
  label: string;
  /** One quiet line of context (owner, mailbox, email, account). */
  detail: string;
  /** Same-origin console path that opens it. */
  href: string;
};

export type SearchResult = { query: string; hits: SearchHit[] };

/** Results per kind; the app bar shows a short list, the pages do the rest. */
export const SEARCH_PER_KIND = 5;
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;

/** Search text from untrusted input: trimmed, lower-cased, at most 100 characters. */
export function normaliseSearch(input: unknown): string {
  return typeof input === "string" ? input.trim().slice(0, SEARCH_MAX_LENGTH).toLowerCase() : "";
}

/** Prefix matches first, then anything containing the text; at most `SEARCH_PER_KIND`. */
export function rank<T>(items: readonly T[], query: string, fields: (item: T) => (string | null)[]): T[] {
  const scored = items.flatMap((item) => {
    const values = fields(item).flatMap((v) => (v ? [v.toLowerCase()] : []));
    if (values.some((v) => v.startsWith(query))) return [{ item, score: 0 }];
    if (values.some((v) => v.includes(query))) return [{ item, score: 1 }];
    return [];
  });
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, SEARCH_PER_KIND)
    .map((s) => s.item);
}

const enc = encodeURIComponent;

export async function consoleSearch(
  deps: Deps,
  actor: Actor,
  rawQuery: unknown,
  accountNames: Record<string, string> = {},
): Promise<SearchResult> {
  const query = normaliseSearch(rawQuery);
  if (actor.kind !== "user" || query.length < SEARCH_MIN_LENGTH) return { query, hits: [] };
  const many = actor.memberships.length > 1;
  const where = (accountId: string, text: string) =>
    many ? `${text}${text ? " · " : ""}${accountNames[accountId] ?? "Account"}` : text;

  const perAccount = await Promise.all(
    actor.memberships.map(async ({ accountId }): Promise<SearchHit[]> => {
      const base = `/accounts/${enc(accountId)}`;
      const hits: SearchHit[] = [];
      if (can(actor, "mailbox.read", accountId)) {
        const mailboxes = await listMailboxes(deps, actor, accountId);
        for (const m of rank(mailboxes, query, (m) => [m.address, m.owner?.email ?? null])) {
          hits.push({
            kind: "mailbox",
            id: m.id,
            label: m.address,
            detail: where(accountId, m.owner ? `Belongs to ${m.owner.email}` : "Not assigned"),
            href: `${base}/mailboxes?mailbox=${enc(m.id)}`,
          });
        }
      }
      if (can(actor, "alias.manage.own", accountId)) {
        const { aliases } = await listAliases(deps, actor, accountId);
        for (const a of rank(aliases, query, (a) => [a.address, a.description, a.mailbox.address])) {
          hits.push({
            kind: "alias",
            id: a.id,
            label: a.address,
            detail: where(accountId, `${a.kind === "masked" ? "Masked alias" : "Alias"} to ${a.mailbox.address}`),
            href: `${base}/aliases?q=${enc(a.address)}`,
          });
        }
      }
      if (can(actor, "domain.read", accountId)) {
        const domains = await listDomains(deps, actor, accountId);
        for (const d of rank(domains, query, (d) => [d.name])) {
          hits.push({
            kind: "domain",
            id: d.id,
            label: d.name,
            detail: where(accountId, d.status === "pending_dns" ? "Waiting for DNS" : "Domain"),
            href: `${base}/domains?domain=${enc(d.id)}`,
          });
        }
      }
      if (can(actor, "member.read", accountId)) {
        const { members } = await listPeople(deps, actor, accountId);
        for (const p of rank(members, query, (p) => [p.name, p.email])) {
          hits.push({
            kind: "person",
            id: p.userId,
            label: p.name || p.email,
            detail: where(accountId, p.email),
            href: `${base}/people?person=${enc(p.userId)}`,
          });
        }
      }
      return hits;
    }),
  );

  const accounts: SearchHit[] = can(actor, "platform.accounts.read")
    ? (await searchAccounts(deps, actor, { query })).rows.slice(0, SEARCH_PER_KIND).map((a) => ({
        kind: "account",
        id: a.id,
        label: a.name,
        detail: "Customer account",
        href: `/platform/accounts/${enc(a.id)}`,
      }))
    : [];

  // Grouped by kind, in a fixed order, each capped.
  const order: SearchKind[] = ["mailbox", "alias", "domain", "person", "account"];
  const all = [...perAccount.flat(), ...accounts];
  return {
    query,
    hits: order.flatMap((kind) => all.filter((h) => h.kind === kind).slice(0, SEARCH_PER_KIND)),
  };
}
