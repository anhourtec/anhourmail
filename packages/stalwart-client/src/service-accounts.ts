// SPDX-License-Identifier: MIT
/**
 * Service accounts that own the control plane's API keys (`keys.ts`). Used by a deployment's bootstrap plan with an
 * administrator credential, and by the integration tests; never by the running apps.
 *
 * Each account has no password and a custom role holding exactly its key's permissions (not the Admin role): a key is
 * capped by its account's role, and a password later set on the account — which any key with `sysAccountUpdate` can
 * do — signs in with the role's permissions only (verified on v0.16.27: with the Admin role that was a full
 * administrator). The account's `credentials` are written only when it is created: Stalwart replaces the whole list,
 * which would drop the live keys.
 */
import { StalwartError } from "./client";
import { SERVICE_CREDENTIALS, type StalwartCredentialRole } from "./keys";
import type { StalwartManagement } from "./management";

type Flags = Record<string, boolean>;
type Role = {
  id: string;
  description?: string;
  enabledPermissions?: Flags;
  disabledPermissions?: Flags;
  roleIds?: Flags;
};
type Account = {
  id: string;
  name: string;
  domainId: string;
  roles?: { "@type"?: string; roleIds?: Flags };
  permissions?: { "@type"?: string };
  credentials?: Record<string, { "@type"?: string }>;
};
type Key = {
  id: string;
  description?: string;
  createdAt?: string;
  expiresAt?: string | null;
  allowedIps?: Flags;
  permissions?: { "@type"?: string; permissions?: Flags };
};

const flags = (names: readonly string[]): Flags => Object.fromEntries(names.map((n) => [n, true] as const));
const on = (f: Flags | undefined): string[] => Object.keys(f ?? {}).filter((k) => f?.[k] === true);
const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");

/** The custom role's description: how the plan finds it again. */
export const serviceRoleDescription = (role: StalwartCredentialRole): string =>
  `anhourmail ${SERVICE_CREDENTIALS[role].account}`;

/** Creates or corrects the role holding exactly the key's permissions. Returns its id. */
export async function ensureServiceRole(mgmt: StalwartManagement, role: StalwartCredentialRole): Promise<string> {
  const want = SERVICE_CREDENTIALS[role].permissions;
  const fields = { enabledPermissions: flags(want), disabledPermissions: {}, roleIds: {} };
  const roles = await mgmt.transport.getAll<Role>("x:Role", [
    "description",
    "enabledPermissions",
    "disabledPermissions",
    "roleIds",
  ]);
  const existing = roles.find((r) => r.description === serviceRoleDescription(role));
  if (existing) {
    const exact =
      same(on(existing.enabledPermissions), want) &&
      on(existing.disabledPermissions).length === 0 &&
      on(existing.roleIds).length === 0;
    if (!exact) await mgmt.transport.set("x:Role", { update: { [existing.id]: fields } });
    return existing.id;
  }
  const { created } = await mgmt.transport.set("x:Role", {
    create: { r: { description: serviceRoleDescription(role), ...fields } },
  });
  const id = created.r?.id;
  if (!id) throw new StalwartError(`Role for ${SERVICE_CREDENTIALS[role].account} was not created`, "set");
  return id;
}

async function findAccount(
  mgmt: StalwartManagement,
  role: StalwartCredentialRole,
  domainId: string,
): Promise<Account | undefined> {
  const name = SERVICE_CREDENTIALS[role].account;
  const accounts = await mgmt.transport.getAll<Account>("x:Account", [
    "name",
    "domainId",
    "roles",
    "permissions",
    "credentials",
  ]);
  return accounts.find((a) => a.domainId === domainId && a.name.toLowerCase() === name);
}

/**
 * Creates the service account (no credentials, the custom role) or puts its role and description right. Never
 * touches the credentials of an existing account.
 */
export async function ensureServiceAccount(
  mgmt: StalwartManagement,
  role: StalwartCredentialRole,
  domainId: string,
): Promise<{ id: string; created: boolean }> {
  const roleId = await ensureServiceRole(mgmt, role);
  const fields = {
    roles: { "@type": "Custom", roleIds: { [roleId]: true } },
    description: `AnhourMail ${role} key (no password; ${SERVICE_CREDENTIALS[role].usedBy} only)`,
  };
  const existing = await findAccount(mgmt, role, domainId);
  if (existing) {
    await mgmt.transport.set("x:Account", { update: { [existing.id]: fields } });
    return { id: existing.id, created: false };
  }
  const { created } = await mgmt.transport.set("x:Account", {
    create: { s: { "@type": "User", name: SERVICE_CREDENTIALS[role].account, domainId, credentials: {}, ...fields } },
  });
  const id = created.s?.id;
  if (!id) throw new StalwartError(`${SERVICE_CREDENTIALS[role].account} was not created`, "set");
  return { id, created: true };
}

/** The account's API keys (never secrets), oldest first. */
export async function listServiceKeys(
  mgmt: StalwartManagement,
  accountId: string,
): Promise<{ id: string; description: string; createdAt: Date }[]> {
  const keys = await mgmt.transport.getAll<Key>("x:ApiKey", ["description", "createdAt"], null, accountId);
  return keys
    .map((k) => ({ id: k.id, description: k.description ?? "", createdAt: new Date(k.createdAt ?? 0) }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * Issues a key with exactly the role's permissions (`Replace`), limited to `allowedIps` (empty = anywhere; tests
 * only) and expiring at `expiresAt`. Returns the secret, which Stalwart shows only this once.
 */
export async function issueServiceKey(
  mgmt: StalwartManagement,
  role: StalwartCredentialRole,
  accountId: string,
  opts: { description: string; allowedIps: readonly string[]; expiresAt: Date | null },
): Promise<string> {
  const { created } = await mgmt.transport.set("x:ApiKey", {
    accountId,
    create: {
      k: {
        description: opts.description,
        permissions: { "@type": "Replace", permissions: flags(SERVICE_CREDENTIALS[role].permissions) },
        allowedIps: flags(opts.allowedIps),
        expiresAt: opts.expiresAt ? opts.expiresAt.toISOString().replace(/\.\d+Z$/, "Z") : null,
      },
    },
  });
  const secret = created.k?.secret;
  if (typeof secret !== "string") throw new StalwartError("API key created without a secret in the response", "set");
  return secret;
}

/**
 * What is wrong with a service account, for the plan's final assertion and smoke checks: it must exist with the
 * custom role holding exactly its key's set, no account-level permissions, no password or app password, at least one
 * API key, and every key `Replace` with exactly the set (and `allowedIps`, when given). Names only, never secrets.
 */
export async function serviceAccountProblems(
  mgmt: StalwartManagement,
  role: StalwartCredentialRole,
  domainId: string,
  opts: { allowedIps?: readonly string[]; maxKeys?: number } = {},
): Promise<string[]> {
  const name = SERVICE_CREDENTIALS[role].account;
  const want = SERVICE_CREDENTIALS[role].permissions;
  const account = await findAccount(mgmt, role, domainId);
  if (!account) return [`${name}: missing`];
  const problems: string[] = [];
  const roleIds = on(account.roles?.roleIds);
  const roles = await mgmt.transport.getAll<Role>("x:Role", [
    "description",
    "enabledPermissions",
    "disabledPermissions",
  ]);
  const assigned = roles.find((r) => r.id === roleIds[0]);
  if (account.roles?.["@type"] !== "Custom" || roleIds.length !== 1 || !assigned) {
    problems.push(`${name}: role is ${JSON.stringify(account.roles)}, expected its custom role only`);
  } else if (
    assigned.description !== serviceRoleDescription(role) ||
    !same(on(assigned.enabledPermissions), want) ||
    on(assigned.disabledPermissions).length > 0
  ) {
    problems.push(`${name}: its role doesn't hold exactly the key's permissions`);
  }
  if ((account.permissions?.["@type"] ?? "Inherit") !== "Inherit") problems.push(`${name}: account-level permissions`);
  const types = Object.values(account.credentials ?? {}).map((c) => c["@type"] ?? "?");
  if (types.includes("Password")) problems.push(`${name}: has a password`);
  if (types.includes("AppPassword")) problems.push(`${name}: has an app password`);
  const keys = await mgmt.transport.getAll<Key>(
    "x:ApiKey",
    ["description", "permissions", "allowedIps", "expiresAt"],
    null,
    account.id,
  );
  if (keys.length === 0) problems.push(`${name}: no API key`);
  if (opts.maxKeys !== undefined && keys.length > opts.maxKeys) {
    problems.push(`${name}: ${String(keys.length)} API keys (prune)`);
  }
  if (types.filter((t) => t === "ApiKey").length !== keys.length) problems.push(`${name}: API key list mismatch`);
  for (const k of keys) {
    if (k.permissions?.["@type"] !== "Replace" || !same(on(k.permissions.permissions), want)) {
      problems.push(`${name}: key ${k.id} doesn't carry exactly its set`);
    }
    if (opts.allowedIps && !same(on(k.allowedIps), opts.allowedIps)) {
      problems.push(`${name}: key ${k.id} allowedIps differ`);
    }
  }
  return problems;
}
