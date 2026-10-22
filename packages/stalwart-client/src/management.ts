// SPDX-License-Identifier: MIT
import { type StalwartTransport } from "./client";

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
};

/**
 * How a suspended account looks on Stalwart v0.16 (verified against the pinned server; research/stalwart.md
 * "Suspending an account"). `x:Account` has no enabled flag, so suspension disables permissions on top of the
 * account's role (`Merge` + `disabledPermissions`, which win over anything the role grants): no sign-in over any
 * protocol (`authenticate` covers JMAP, SMTP AUTH and app passwords; the protocol ones close IMAP, POP3 and
 * ManageSieve logins), no sending, and no delivery (`emailReceive`: mail to it or its aliases is bounced to the
 * sender). Credentials, app passwords and stored mail are untouched, so resuming (`Inherit`) restores everything.
 */
export const SUSPENDED_PERMISSIONS = {
  "@type": "Merge",
  enabledPermissions: {},
  disabledPermissions: {
    authenticate: true,
    imapAuthenticate: true,
    pop3Authenticate: true,
    sieveAuthenticate: true,
    emailSend: true,
    emailReceive: true,
  },
} as const;

const ROLE_PERMISSIONS = { "@type": "Inherit" } as const;

/** Sign-in turned off by our suspension (what the reconciler compares). */
const isSuspended = (p: { disabledPermissions?: Record<string, boolean> } | undefined): boolean =>
  p?.disabledPermissions?.authenticate === true;

export type RelayRouteInput = { name: string; description: string; host: string; port: number };

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
      ...(input.suspended === undefined
        ? {}
        : { permissions: input.suspended ? SUSPENDED_PERMISSIONS : ROLE_PERMISSIONS }),
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
          permissions: ROLE_PERMISSIONS,
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
    { id: string; address: string; quotaBytes: number | null; aliases: string[]; suspended: boolean }[]
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
      }));
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

  /** Recompiles listeners, MTA routing and expressions. Directory changes apply without it. */
  async reloadSettings(): Promise<void> {
    await this.transport.set("x:Action", { create: { a: { "@type": "ReloadSettings" } } });
  }
}
