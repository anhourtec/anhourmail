// SPDX-License-Identifier: MIT
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  appPasswordPermissions,
  type AppPasswordScope,
  PRINCIPAL_READ_PERMISSIONS,
  SELF_SERVICE_PERMISSIONS,
} from "./app-passwords";
import { StalwartError, type StalwartTransport } from "./client";

/**
 * Typed management operations used by the control plane, worker and dev seeding. Every write is idempotent:
 * look up by natural key (name), create if missing, update if present. Provisioning callers run these from
 * jobs, never inline in a request (CLAUDE.md rule 26).
 */

export type DomainInput = {
  name: string;
  /** Unknown recipients go here; omitted = reject at SMTP time. */
  catchAllAddress?: string;
  subAddressing?: boolean;
};

export type UserInput = {
  /** Local part only; the address is `${name}@${domain}`. */
  name: string;
  domain: string;
  /**
   * The mailbox password as a salted argon2id PHC string (`$argon2id$…`), hashed by the caller — Stalwart
   * stores it as-is, so the plaintext never crosses the management API and the algorithm is ours to choose
   * (docs/internal/07-security.md "Password storage"). We never store it ourselves (CLAUDE.md rule 23).
   */
  password: string;
  quotaBytes: number;
  /** Re-set the password on an existing account too (dev seed); new accounts always get it. */
  resetPassword?: boolean;
  /**
   * true: suspend (see `SUSPENDED_PERMISSIONS`); false: back to the role's permissions; omitted: leave them as
   * they are.
   */
  suspended?: boolean;
  aliases?: { name: string; domain: string; enabled: boolean; description?: string }[];
  /** The account's description (our mailbox display name); null clears it, omitted leaves it as it is. */
  description?: string | null;
};

/**
 * What no customer mailbox may do on the mail server (verified on v0.16.27, 2026-10-22; security reviews run-20/21).
 * We own the mailbox's one Sieve script (automatic replies, forwarding, junk rules; written with management
 * credentials — 05-webmail.md "Settings"), so end users may not change mail flow themselves: a user Sieve `redirect`
 * or `enotify` is an open relay from our IPs that skips forwarding confirmation, quotas and audit, and a user
 * `VacationResponse/set` installs and activates Stalwart's own `vacation` script, switching ours off.
 * `sieveAuthenticate` closes ManageSieve (port 4190); `jmapSieveScript{Create,Update,Destroy}` close `SieveScript/set`
 * (with `Destroy` denied, a bare `SieveScript/set { onSuccessDeactivateScript }` is refused too — verified run-22; with
 * only create/update denied a user could deactivate our script and then delete it); `jmapVacationResponse{Create,
 * Update,Destroy}` close `VacationResponse/set`. (`jmapSieveScriptSet/Delete/Activate/Rename` and
 * `jmapVacationResponseSet` don't exist on the pinned server.) Reading scripts, blob upload (attachments), sign-in,
 * sending and delivery are untouched. The rest of the list (ADR-0020, run-21/22 reviews) is below.
 */
const CUSTOMER_DENIALS = {
  sieveAuthenticate: true,
  jmapSieveScriptCreate: true,
  jmapSieveScriptUpdate: true,
  jmapSieveScriptDestroy: true,
  jmapVacationResponseCreate: true,
  jmapVacationResponseUpdate: true,
  jmapVacationResponseDestroy: true,
  // No directory search over DAV: `principal-property-search` found accounts on every domain (verified). CardDAV and
  // CalDAV discovery (well-known, current-user-principal, home sets, PROPFIND, PUT) still work without these.
  davPrincipalSearch: true,
  davPrincipalSearchPropSet: true,
  davPrincipalList: true,
  davPrincipalMatch: true,
  // No sharing (not a product feature; delegation is a console action, rule 49). There is no share permission of its
  // own: `shareWith` rides on `/set` create and update, so mailbox and calendar create/update are off (the webmail
  // never sends them; IMAP CREATE/RENAME still work), and every ACL method is off. Address books stay writable: the
  // webmail creates and updates them (contacts auto-save) — `AddressBook/set { shareWith }` is a known gap
  // (research/stalwart.md "Sharing").
  jmapMailboxCreate: true,
  jmapMailboxUpdate: true,
  jmapCalendarCreate: true,
  jmapCalendarUpdate: true,
  imapAclSet: true,
  davCardAcl: true,
  davCalAcl: true,
  davFileAcl: true,
  davPrincipalAcl: true,
  // ADR-0020: no self-service credentials or password change (app passwords and API keys are made by the console with
  // the management key, which these don't limit — verified), and no principal look-ups (`Principal/query` otherwise
  // lists every account on the server). The webmail never needs them on a user's token.
  ...Object.fromEntries([...SELF_SERVICE_PERMISSIONS, ...PRINCIPAL_READ_PERMISSIONS].map((p) => [p, true] as const)),
} as const;

/**
 * How a suspended account looks on Stalwart v0.16 (verified against the pinned server; research/stalwart.md
 * "Suspending an account"). `x:Account` has no enabled flag, so suspension disables permissions on top of the
 * account's role (`Merge` + `disabledPermissions`, which win over anything the role grants): no sign-in over any
 * protocol (`authenticate` covers JMAP, SMTP AUTH and app passwords; the protocol ones close IMAP, POP3 and
 * ManageSieve logins), no sending, and no delivery (`emailReceive`: mail to it or its aliases is bounced to the
 * sender). Credentials, app passwords and stored mail are untouched. A superset of `CUSTOMER_PERMISSIONS`, so
 * resuming (back to `CUSTOMER_PERMISSIONS`) never briefly unlocks Sieve.
 */
export const SUSPENDED_PERMISSIONS = {
  "@type": "Merge",
  enabledPermissions: {},
  disabledPermissions: {
    ...CUSTOMER_DENIALS,
    authenticate: true,
    imapAuthenticate: true,
    pop3Authenticate: true,
    emailSend: true,
    emailReceive: true,
  },
} as const;

/** A normal (non-suspended) customer mailbox: the role's permissions minus `CUSTOMER_DENIALS`. */
export const CUSTOMER_PERMISSIONS = {
  "@type": "Merge",
  enabledPermissions: {},
  disabledPermissions: { ...CUSTOMER_DENIALS },
} as const;

/** Sign-in turned off by our suspension (what the reconciler compares). */
const isSuspended = (p: { disabledPermissions?: Record<string, boolean> } | undefined): boolean =>
  p?.disabledPermissions?.authenticate === true;

/** Every customer denial present (suspension includes them): the user can't change mail flow (reconciler check). */
const isSieveLocked = (p: { disabledPermissions?: Record<string, boolean> } | undefined): boolean =>
  Object.keys(CUSTOMER_DENIALS).every((k) => p?.disabledPermissions?.[k] === true);

export type RelayRouteInput = { name: string; description: string; host: string; port: number };

/**
 * Header on the one management call that replaces a mailbox password (`replacePassword`). The production management
 * proxy refuses every credentials write without it, and with it accepts only a single Password slot replacement with
 * an argon2id hash on a non-service account. It is a marker the worker adds, not a secret or a control by itself.
 */
export const MAILBOX_PASSWORD_HEADER = "X-AnhourMail-Credential-Write";

/**
 * A salted argon2id PHC string at exactly the control plane's parameters (m=19456 KiB, t=2, p=1), with a bounded salt
 * and hash, as `@node-rs/argon2` writes it. The management proxy checks the same shape.
 */
export const ARGON2ID_PHC = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{16,64}\$[A-Za-z0-9+/]{32,128}$/;

/** Header carrying the web app's grant for one password replacement (`mailboxPasswordGrant`). */
export const MAILBOX_PASSWORD_GRANT_HEADER = "X-AnhourMail-Password-Grant";

/** Longest a grant may be valid for (the management proxy refuses a later expiry). */
export const MAILBOX_PASSWORD_GRANT_MAX_SEC = 3600;

const grantMessage = (accountId: string, passwordHash: string, expiresAt: number) =>
  `${accountId}|${createHash("sha256").update(passwordHash).digest("hex")}|${String(expiresAt)}`;

/**
 * The web app's grant for replacing `accountId`'s password with exactly `passwordHash`: `<expiry>.<hex HMAC-SHA256>`
 * of `accountId|sha256hex(passwordHash)|expiry` (epoch seconds, at most an hour ahead) under a key only the web app
 * and the management proxy hold — so whoever holds the provisioning key alone (the worker) can't make one.
 */
export function mailboxPasswordGrant(key: string, accountId: string, passwordHash: string, nowMs = Date.now()): string {
  const expiresAt = Math.floor(nowMs / 1000) + MAILBOX_PASSWORD_GRANT_MAX_SEC;
  const mac = createHmac("sha256", key)
    .update(grantMessage(accountId, passwordHash, expiresAt))
    .digest("hex");
  return `${String(expiresAt)}.${mac}`;
}

/** What the management proxy checks (tests and tooling): the grant matches, in constant time, and hasn't expired. */
export function verifyMailboxPasswordGrant(
  key: string,
  grant: string,
  accountId: string,
  passwordHash: string,
  nowMs = Date.now(),
): boolean {
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(grant);
  if (!m) return false;
  const expiresAt = Number(m[1]);
  const now = Math.floor(nowMs / 1000);
  if (expiresAt < now || expiresAt > now + MAILBOX_PASSWORD_GRANT_MAX_SEC) return false;
  const want = createHmac("sha256", key)
    .update(grantMessage(accountId, passwordHash, expiresAt))
    .digest();
  return timingSafeEqual(want, Buffer.from(m[2] ?? "", "hex"));
}

/** An app password as Stalwart lists it: never the secret (it answers `****`). */
export type AppPasswordRecord = { id: string; description: string; createdAt: Date };

type Named = { id: string; name: string };

const list = <T>(items: T[]): Record<string, T> => Object.fromEntries(items.map((v, i) => [String(i), v]));

export class StalwartManagement {
  constructor(readonly transport: StalwartTransport) {}

  ready(): Promise<void> {
    return this.transport.ready();
  }

  /**
   * Tenancy seam (ADR-0002). Community edition has no tenants: plan limits and ownership are enforced by our
   * control plane, so this is a no-op. Stalwart Enterprise would map an account to an `x:Tenant` here.
   */
  async ensureTenant(_accountId: string): Promise<null> {
    return null;
  }

  async findDomain(name: string): Promise<Named | undefined> {
    const all = await this.transport.getAll<Named>("x:Domain", ["name"]);
    return all.find((d) => d.name === name);
  }

  async upsertDomain(input: DomainInput): Promise<string> {
    const fields: Record<string, unknown> = {
      subAddressing: { "@type": input.subAddressing === false ? "Disabled" : "Enabled" },
      catchAllAddress: input.catchAllAddress ?? null,
    };
    const existing = await this.findDomain(input.name);
    if (existing) {
      await this.transport.set("x:Domain", { update: { [existing.id]: fields } });
      return existing.id;
    }
    const { created } = await this.transport.set("x:Domain", {
      create: {
        d: {
          name: input.name,
          aliases: {},
          certificateManagement: { "@type": "Manual" },
          dkimManagement: { "@type": "Automatic" },
          dnsManagement: { "@type": "Manual" },
          ...fields,
        },
      },
    });
    const id = created.d?.id;
    if (!id) throw new Error(`Domain ${input.name} was not created`);
    return id;
  }

  /** The zone Stalwart expects for a domain (MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, SRV, autoconfig). */
  async domainZoneFile(domainId: string): Promise<string> {
    const [d] = await this.transport.getAll<{ id: string; dnsZoneFile?: string }>(
      "x:Domain",
      ["dnsZoneFile"],
      [domainId],
    );
    return d?.dnsZoneFile ?? "";
  }

  async upsertUser(input: UserInput): Promise<string> {
    const domains = await this.transport.getAll<Named>("x:Domain", ["name"]);
    const domainId = (name: string) => {
      const d = domains.find((x) => x.name === name);
      if (!d) throw new Error(`Unknown domain ${name}`);
      return d.id;
    };
    const fields = {
      quotas: { maxDiskQuota: input.quotaBytes },
      // A customer mailbox never gets to write its own Sieve (CUSTOMER_PERMISSIONS); a suspended one is turned off
      // entirely (SUSPENDED_PERMISSIONS). `undefined` leaves permissions as they are.
      ...(input.suspended === undefined
        ? {}
        : { permissions: input.suspended ? SUSPENDED_PERMISSIONS : CUSTOMER_PERMISSIONS }),
      ...(input.description === undefined ? {} : { description: input.description }),
      aliases: list(
        (input.aliases ?? []).map((a) => ({
          name: a.name,
          domainId: domainId(a.domain),
          enabled: a.enabled,
          description: a.description ?? null,
        })),
      ),
    };
    const users = await this.transport.getAll<Named & { domainId: string }>("x:Account", ["name", "domainId"]);
    const existing = users.find((u) => u.name === input.name && u.domainId === domainId(input.domain));
    if (existing) {
      const update = input.resetPassword
        ? { ...fields, credentials: list([{ "@type": "Password", secret: input.password }]) }
        : fields;
      await this.transport.set("x:Account", { update: { [existing.id]: update } });
      return existing.id;
    }
    const { created } = await this.transport.set("x:Account", {
      create: {
        u: {
          "@type": "User",
          name: input.name,
          domainId: domainId(input.domain),
          credentials: list([{ "@type": "Password", secret: input.password }]),
          roles: { "@type": "User" },
          // New accounts are always locked down, even when the caller didn't say (dev seed, e2e fixtures).
          permissions: CUSTOMER_PERMISSIONS,
          ...fields,
        },
      },
    });
    const id = created.u?.id;
    if (!id) throw new Error(`Account ${input.name}@${input.domain} was not created`);
    return id;
  }

  async upsertRelayRoute(input: RelayRouteInput): Promise<string> {
    const fields = {
      description: input.description,
      address: input.host,
      port: input.port,
      protocol: "smtp",
      implicitTls: false,
      allowInvalidCerts: true,
      authSecret: { "@type": "None" },
    };
    const routes = await this.transport.getAll<Named>("x:MtaRoute", ["name"]);
    const existing = routes.find((r) => r.name === input.name);
    if (existing) {
      await this.transport.set("x:MtaRoute", { update: { [existing.id]: fields } });
      return existing.id;
    }
    const { created } = await this.transport.set("x:MtaRoute", {
      create: { r: { "@type": "Relay", name: input.name, ...fields } },
    });
    const id = created.r?.id;
    if (!id) throw new Error(`Route ${input.name} was not created`);
    return id;
  }

  /** Local recipients deliver locally; every other recipient goes to `remoteRoute`. */
  async setRemoteRoute(remoteRoute: string): Promise<void> {
    await this.transport.set("x:MtaOutboundStrategy", {
      update: {
        singleton: {
          route: { match: { "0": { if: "is_local_domain(rcpt_domain)", then: "'local'" } }, else: `'${remoteRoute}'` },
        },
      },
    });
  }

  async remoteRoute(): Promise<string | undefined> {
    const [s] = await this.transport.getAll<{ id: string; route?: { else?: string } }>(
      "x:MtaOutboundStrategy",
      ["route"],
      ["singleton"],
    );
    return s?.route?.else?.replace(/^'|'$/g, "");
  }

  /**
   * Adds a listener if no listener with that name exists (e.g. 587 submission, absent by default).
   * Returns true when it created one: new sockets bind only after a Stalwart restart.
   */
  async ensureListener(input: {
    name: string;
    port: number;
    protocol: "smtp" | "imap" | "pop3" | "http" | "manageSieve";
    implicitTls: boolean;
  }): Promise<boolean> {
    const listeners = await this.transport.getAll<Named>("x:NetworkListener", ["name"]);
    if (listeners.some((l) => l.name === input.name)) return false;
    await this.transport.set("x:NetworkListener", {
      create: {
        l: {
          name: input.name,
          bind: { [`[::]:${input.port}`]: true },
          protocol: input.protocol,
          useTls: true,
          tlsImplicit: input.implicitTls,
        },
      },
    });
    return true;
  }

  async listDomains(): Promise<{ id: string; name: string }[]> {
    return this.transport.getAll<Named>("x:Domain", ["name"]);
  }

  /** Individual accounts as full addresses with their disk quota, aliases and whether they are suspended. */
  async listUsers(): Promise<
    {
      id: string;
      address: string;
      quotaBytes: number | null;
      aliases: string[];
      suspended: boolean;
      /** Every customer denial is in place (the user can't change mail flow). */
      sieveLocked: boolean;
    }[]
  > {
    const [domains, accounts] = await Promise.all([
      this.listDomains(),
      this.transport.getAll<{
        id: string;
        "@type"?: string;
        name: string;
        domainId: string;
        quotas?: { maxDiskQuota?: number };
        aliases?: Record<string, { name: string; domainId: string }>;
        permissions?: { disabledPermissions?: Record<string, boolean> };
      }>("x:Account", ["name", "domainId", "quotas", "aliases", "permissions"]),
    ]);
    const domainName = new Map(domains.map((d) => [d.id, d.name] as const));
    return accounts
      .filter((a) => a["@type"] === undefined || a["@type"] === "User")
      .map((a) => ({
        id: a.id,
        address: `${a.name}@${domainName.get(a.domainId) ?? "?"}`,
        quotaBytes: a.quotas?.maxDiskQuota ?? null,
        aliases: Object.values(a.aliases ?? {}).map((x) => `${x.name}@${domainName.get(x.domainId) ?? "?"}`),
        suspended: isSuspended(a.permissions),
        sieveLocked: isSieveLocked(a.permissions),
      }));
  }

  /**
   * Storage used by these accounts (`usedDiskQuota`, server-set, in bytes) with each one's name (local part): only those
   * two properties, nothing about the mail. Ids that don't exist are left out. Needs `sysAccountGet` (provisioning key).
   */
  async accountUsage(ids: readonly string[]): Promise<{ id: string; name: string; usedBytes: number }[]> {
    if (ids.length === 0) return [];
    const list = await this.transport.getAll<{ id: string; name?: string; usedDiskQuota?: number }>(
      "x:Account",
      ["name", "usedDiskQuota"],
      [...ids],
    );
    return list.map((a) => ({ id: a.id, name: a.name ?? "", usedBytes: a.usedDiskQuota ?? 0 }));
  }

  /** One individual account by id, as a full address with whether it is suspended; undefined if it doesn't exist. */
  async getUser(id: string): Promise<{ id: string; address: string; suspended: boolean } | undefined> {
    const [account] = await this.transport.getAll<{
      id: string;
      "@type"?: string;
      name: string;
      domainId: string;
      permissions?: { "@type"?: string; disabledPermissions?: Record<string, boolean> };
    }>("x:Account", ["name", "domainId", "permissions"], [id]);
    if (!account || (account["@type"] !== undefined && account["@type"] !== "User")) return undefined;
    const domain = (await this.listDomains()).find((d) => d.id === account.domainId);
    return {
      id: account.id,
      address: `${account.name}@${domain?.name ?? "?"}`,
      suspended: isSuspended(account.permissions),
    };
  }

  /**
   * Destroys an account or domain. For tests and explicit, audited admin actions only — the reconciler never
   * deletes (mail may live there; CLAUDE.md rule 26).
   */
  async destroy(object: "x:Account" | "x:Domain", id: string): Promise<void> {
    await this.transport.set(object, { destroy: [id] });
  }

  /** Destroys a domain after its DKIM keys (Stalwart refuses otherwise). Accounts must already be gone. */
  async destroyDomain(id: string): Promise<void> {
    const keys = await this.transport.getAll<{ id: string; domainId: string }>("x:DkimSignature", ["domainId"]);
    const mine = keys.filter((k) => k.domainId === id).map((k) => k.id);
    if (mine.length > 0) await this.transport.set("x:DkimSignature", { destroy: mine });
    await this.destroy("x:Domain", id);
  }

  /** Partial update of a singleton object (e.g. `x:SpamPyzor`, `x:SystemSettings`). */
  async updateSingleton(object: string, fields: Record<string, unknown>): Promise<void> {
    await this.transport.set(object, { update: { singleton: fields } });
  }

  /** Points the built-in WebUI application at a bundle URL (a pinned local file in dev). */
  /** Returns true when it changed anything (Stalwart then needs a restart to unpack the bundle). */
  async setWebUiResource(resourceUrl: string): Promise<boolean> {
    const apps = await this.transport.getAll<{ id: string; resourceUrl: string }>("x:Application", ["resourceUrl"]);
    const updates = Object.fromEntries(
      apps.filter((a) => a.resourceUrl !== resourceUrl).map((a) => [a.id, { resourceUrl }] as const),
    );
    if (Object.keys(updates).length === 0) return false;
    await this.transport.set("x:Application", { update: updates });
    return true;
  }

  /**
   * Creates an app password on `accountId` (the account's Stalwart id) limited to `scopes`, with the self-service
   * permissions always off (`appPasswordPermissions`). Needs the operations key: `sysAppPassword*` and `impersonate`
   * (owner access to other accounts; no mail read without the `jmap*` permissions — verified). Returns
   * the secret, which Stalwart shows only this once: the caller hands it to the person and never stores it.
   */
  async createAppPassword(
    accountId: string,
    input: { description: string; scopes: readonly AppPasswordScope[] },
  ): Promise<AppPasswordRecord & { secret: string }> {
    const { created } = await this.transport.set("x:AppPassword", {
      accountId,
      create: { a: { description: input.description, permissions: appPasswordPermissions(input.scopes) } },
    });
    const id = created.a?.id;
    const secret = created.a?.secret;
    if (typeof id !== "string" || typeof secret !== "string") {
      throw new StalwartError("App password was not returned", "set");
    }
    const record = await this.appPassword(accountId, id);
    if (!record) throw new StalwartError("App password vanished after creation", "set");
    return { ...record, secret };
  }

  /** One app password of an account (no secret); undefined if there is none with that id. */
  async appPassword(accountId: string, id: string): Promise<AppPasswordRecord | undefined> {
    return (await this.listAppPasswords(accountId, [id]))[0];
  }

  /** The account's app passwords (no secrets), or only `ids`. */
  async listAppPasswords(accountId: string, ids: string[] | null = null): Promise<AppPasswordRecord[]> {
    const list = await this.transport.getAll<{ id: string; description?: string; createdAt?: string }>(
      "x:AppPassword",
      ["description", "createdAt"],
      ids,
      accountId,
    );
    return list.map((a) => ({ id: a.id, description: a.description ?? "", createdAt: new Date(a.createdAt ?? 0) }));
  }

  /**
   * Revokes one app password with owner access (the operations key; the web app's clean-up when recording a new one
   * fails). Ids are reused after a revocation, so callers match `createdAt` first. Jobs use
   * `revokeAppPasswordCredential`.
   */
  async destroyAppPassword(accountId: string, id: string): Promise<void> {
    await this.transport.set("x:AppPassword", { accountId, destroy: [id] });
  }

  /**
   * Every app password of an account with its `permissions` value, and how many API keys it has (for the
   * reconciler; never secrets). Read from `x:Account.credentials`, so it needs only `sysAccountGet` — no owner access
   * to the mailbox (the provisioning key; verified on v0.16.27: id, description, `createdAt` and `permissions` are
   * listed, secrets as `****`). Throws when the account doesn't exist.
   */
  async credentialInventory(accountId: string): Promise<{
    appPasswords: { id: string; createdAt: Date; permissions: unknown }[];
    apiKeys: number;
    /** Password credentials (the mailbox sign-in password). A mailbox has exactly one; Stalwart refuses a second. */
    passwords: { id: string }[];
  }> {
    const credentials = await this.#credentials(accountId);
    return {
      appPasswords: credentials
        .filter((c) => c.type === "AppPassword")
        .map((c) => ({ id: c.id, createdAt: c.createdAt, permissions: c.permissions })),
      apiKeys: credentials.filter((c) => c.type === "ApiKey").length,
      passwords: credentials.filter((c) => c.type === "Password").map((c) => ({ id: c.id })),
    };
  }

  /**
   * Revokes one app password through `x:Account.credentials` (`sysAccountUpdate`, no owner access to the mailbox):
   * only the entry with this credential id **and** creation time (Stalwart reuses ids), removed with a patch of its
   * list position so every other credential stays. Returns false when it is already gone. Positions can move if a
   * credential is added or removed in between, so the list is read again afterwards and anything else missing is an
   * error (the reconciler would report it as missing on the mail server).
   */
  async revokeAppPasswordCredential(accountId: string, credentialId: string, createdAt: Date): Promise<boolean> {
    const before = await this.#credentials(accountId);
    const target = before.find(
      (c) =>
        c.type === "AppPassword" &&
        c.id === credentialId &&
        Math.abs(c.createdAt.getTime() - createdAt.getTime()) < 1000,
    );
    if (!target) return false;
    await this.transport.set("x:Account", { update: { [accountId]: { [`credentials/${target.index}`]: null } } });
    const after = await this.#credentials(accountId);
    const key = (c: { type: string; id: string; createdAt: Date }) =>
      `${c.type}:${c.id}:${String(c.createdAt.getTime())}`;
    const left = new Set(after.map(key));
    if (left.has(key(target))) throw new StalwartError("App password is still there after revocation", "set");
    if (before.some((c) => c !== target && !left.has(key(c)))) {
      throw new StalwartError("Another credential disappeared during the revocation", "set");
    }
    return true;
  }

  /** The account's one sign-in Password credential id; null when it has none or more than one. */
  async passwordCredentialId(accountId: string): Promise<string | null> {
    const passwords = (await this.#credentials(accountId)).filter((c) => c.type === "Password");
    return passwords.length === 1 ? (passwords[0]?.id ?? null) : null;
  }

  /**
   * Replaces the account's sign-in password with `passwordHash`, a salted argon2id PHC string (Stalwart stores it as
   * is, so the password never crosses the management API — rule 23). Only the one Password credential is replaced,
   * with a patch of its list position, so app passwords and API keys stay (verified on v0.16.27: they keep working,
   * while every OAuth token of the account stops — Stalwart derives them from the password). Needs `sysAccountUpdate`
   * (the provisioning key). The request carries `MAILBOX_PASSWORD_HEADER`, which the production management proxy
   * requires before it lets a credentials write through (a marker, not a control: the proxy checks the patch itself).
   * Throws unless the account has exactly one Password credential before and after, and nothing else changed.
   * Returns the Password credential id afterwards (Stalwart keeps or changes it; it isn't a reliable change marker).
   */
  async replacePassword(
    accountId: string,
    passwordHash: string,
    opts: { grant?: string | null } = {},
  ): Promise<{ credentialId: string }> {
    if (!ARGON2ID_PHC.test(passwordHash))
      throw new StalwartError("Mailbox passwords must be argon2id PHC strings", "set");
    const before = await this.#credentials(accountId);
    const passwords = before.filter((c) => c.type === "Password");
    const slot = passwords[0];
    if (passwords.length !== 1 || !slot) {
      throw new StalwartError("Account doesn't have exactly one password credential", "set");
    }
    await this.transport.set(
      "x:Account",
      { update: { [accountId]: { [`credentials/${slot.index}`]: { "@type": "Password", secret: passwordHash } } } },
      {
        headers: {
          [MAILBOX_PASSWORD_HEADER]: "replace",
          ...(opts.grant ? { [MAILBOX_PASSWORD_GRANT_HEADER]: opts.grant } : {}),
        },
      },
    );
    const after = await this.#credentials(accountId);
    const now = after.filter((c) => c.type === "Password");
    const others = (list: typeof before) =>
      list
        .filter((c) => c.type !== "Password")
        .map((c) => `${c.type}:${c.id}:${String(c.createdAt.getTime())}`)
        .sort()
        .join(",");
    if (now.length !== 1 || !now[0] || others(after) !== others(before)) {
      throw new StalwartError("Credentials changed unexpectedly while setting the password", "set");
    }
    return { credentialId: now[0].id };
  }

  async #credentials(
    accountId: string,
  ): Promise<{ index: string; type: string; id: string; createdAt: Date; permissions: unknown }[]> {
    const [account] = await this.transport.getAll<{
      id: string;
      credentials?: Record<
        string,
        { "@type"?: string; credentialId?: string; createdAt?: string; permissions?: unknown }
      >;
    }>("x:Account", ["credentials"], [accountId]);
    if (!account) throw new StalwartError(`Account ${accountId} not found`, "method");
    return Object.entries(account.credentials ?? {}).map(([index, c]) => ({
      index,
      type: c["@type"] ?? "",
      id: c.credentialId ?? "",
      createdAt: new Date(c.createdAt ?? 0),
      permissions: c.permissions,
    }));
  }

  /** What this client's credential can do (`GET /api/account`; see `keys.ts`). */
  credentialPermissions(): Promise<string[]> {
    return this.transport.credentialPermissions();
  }

  /** Recompiles listeners, MTA routing and expressions. Directory changes apply without it. */
  async reloadSettings(): Promise<void> {
    await this.transport.set("x:Action", { create: { a: { "@type": "ReloadSettings" } } });
  }

  // ---- managed Sieve script (the webmail's automatic replies, forwarding and junk rules) ---------------------
  //
  // Customer mailboxes can't write their own Sieve (CUSTOMER_PERMISSIONS), so the one script we own is written and
  // read here with management credentials, standard JMAP (`urn:ietf:params:jmap:sieve`): written by the web app with
  // the operations key, read by the reconciler with the audit key (both need `impersonate`; the provisioning key has
  // no access). `accountId` is the mailbox's JMAP account id (equal to its x:Account id, verified on v0.16.27).

  /** The mailbox's managed script `name` (its text and whether it's the active one), or null when it has none. */
  async getSieveScript(accountId: string, name: string): Promise<{ content: string; active: boolean } | null> {
    const res = await this.transport.rawCall(SIEVE_USING, [
      ["SieveScript/get", { accountId, properties: ["name", "blobId", "isActive"] }, "g"],
    ]);
    const list = (res.get("g")?.list ?? []) as { name: string; blobId: string; isActive?: boolean }[];
    const script = list.find((s) => s.name === name);
    if (!script) return null;
    return { content: await this.transport.downloadBlob(accountId, script.blobId), active: script.isActive === true };
  }

  /**
   * Makes the managed script `name` the active one again if something switched it off, without rewriting it. Needs
   * owner access and `jmapSieveScriptUpdate` (the operations key; nothing in the worker can). No-op when it doesn't
   * exist or is already active; no other script is deleted.
   */
  async activateSieveScript(accountId: string, name: string): Promise<boolean> {
    const res = await this.transport.rawCall(SIEVE_USING, [
      ["SieveScript/get", { accountId, properties: ["name", "isActive"] }, "g"],
    ]);
    const ours = ((res.get("g")?.list ?? []) as { id: string; name: string; isActive?: boolean }[]).find(
      (s) => s.name === name,
    );
    if (!ours || ours.isActive === true) return false;
    await this.transport.rawCall(SIEVE_USING, [
      ["SieveScript/set", { accountId, onSuccessActivateScript: ours.id }, "s"],
    ]);
    return true;
  }

  /**
   * Writes the mailbox's managed script `name` with `content` and makes it the active one (creating or updating the
   * one script with that name). Returns nothing; throws on refusal.
   */
  async putSieveScript(accountId: string, name: string, content: string): Promise<void> {
    const blobId = await this.transport.uploadBlob(accountId, "application/sieve", content);
    const got = await this.transport.rawCall(SIEVE_USING, [
      ["SieveScript/get", { accountId, properties: ["name"] }, "g"],
    ]);
    const existing = (got.get("g")?.list ?? []) as { id: string; name: string }[];
    const ours = existing.find((s) => s.name === name);
    const call = ours
      ? { accountId, update: { [ours.id]: { blobId } }, onSuccessActivateScript: ours.id }
      : { accountId, create: { s: { name, blobId } }, onSuccessActivateScript: "#s" };
    const res = (await this.transport.rawCall(SIEVE_USING, [["SieveScript/set", call, "s"]])).get("s") ?? {};
    const failed = (
      ours
        ? (res.notUpdated as Record<string, { type?: string }> | undefined)?.[ours.id]
        : (res.notCreated as Record<string, { type?: string }> | undefined)?.s
    ) as { type?: string } | undefined;
    if (failed) throw new StalwartError(`SieveScript/set ${failed.type ?? "failed"}`, "set", failed);
  }
}

const SIEVE_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:sieve"] as const;
