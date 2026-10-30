// SPDX-License-Identifier: MIT
import { StalwartTransport } from "./client";
import {
  credentialEnvProblems,
  credentialScopeProblems,
  SERVICE_CREDENTIALS,
  type StalwartCredentialRole,
} from "./keys";
import { StalwartManagement } from "./management";

export {
  type MethodCall,
  type StalwartAuth,
  type StalwartClientOptions,
  StalwartError,
  StalwartTransport,
} from "./client";
export { type DkimRecord, dkimTags, parseDkimRecords } from "./dkim";
export {
  ARCHIVE_DEFAULT_FOLDER,
  ARCHIVE_FOLDER_NAME,
  type ArchiveBackfillReport,
  type ArchivePlan,
  type ArchiveResult,
  applyDefaultFolders,
  backfillArchiveFolders,
  ensureArchiveFolder,
  type FolderSummary,
  planArchiveFolder,
} from "./folders";
export {
  appPasswordPermissions,
  type AppPasswordScope,
  CUSTOMER_APP_PASSWORD_QUOTA,
  HANDOFF_CREDENTIAL_DESCRIPTION,
  HANDOFF_CREDENTIAL_MAX_LIFETIME_MS,
  handoffCredentialPermissions,
  isAppPasswordSecret,
  isHandoffCredential,
  KNOWN_PERMISSIONS,
  PRINCIPAL_READ_PERMISSIONS,
  SCOPE_ALLOW,
  scopesOf,
  SELF_SERVICE_PERMISSIONS,
} from "./app-passwords";
export {
  type AppPasswordRecord,
  type DomainInput,
  ARGON2ID_PHC,
  MAILBOX_PASSWORD_GRANT_HEADER,
  MAILBOX_PASSWORD_GRANT_MAX_SEC,
  MAILBOX_PASSWORD_HEADER,
  mailboxPasswordGrant,
  verifyMailboxPasswordGrant,
  type RelayRouteInput,
  StalwartManagement,
  CUSTOMER_PERMISSIONS,
  SUSPENDED_PERMISSIONS,
  type UserInput,
} from "./management";
export {
  AUDIT_KEY_PERMISSIONS,
  CREDENTIAL_ROLES,
  credentialEnvProblems,
  credentialScopeProblems,
  CUSTOMER_EFFECTIVE_PERMISSIONS,
  LEGACY_KEY_ENV,
  LEGACY_SERVICE_ACCOUNT,
  OPERATIONS_KEY_PERMISSIONS,
  PROVISIONING_KEY_PERMISSIONS,
  SERVICE_CREDENTIALS,
  type ServiceCredential,
  type StalwartCredentialRole,
  USER_ROLE_PERMISSIONS,
} from "./keys";
export {
  ensureServiceAccount,
  ensureServiceRole,
  issueServiceKey,
  listServiceKeys,
  serviceAccountProblems,
  serviceRoleDescription,
} from "./service-accounts";
export {
  OAuthDeniedError,
  OAuthThrottledError,
  type OAuthClientInput,
  type OAuthTokens,
  OAuthUnavailableError,
  pkcePair,
  StalwartOAuth,
  type StalwartOAuthOptions,
  upsertOAuthClient,
  WEBMAIL_OAUTH_CLIENT_ID,
  webmailRedirectUri,
} from "./oauth";
export {
  applySenderIdentityPolicy,
  SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION,
  SENDER_IDENTITY_SCRIPT,
  SENDER_IDENTITY_SIEVE,
  SENDER_ON_BEHALF_HEADER,
  senderIdentitySieve,
} from "./sender";

const globalForStalwart = globalThis as unknown as {
  amStalwart?: Partial<Record<StalwartCredentialRole | "devAdmin", StalwartManagement>>;
};

function devAdminAuth(env: Record<string, string | undefined>) {
  const username = env.STALWART_DEV_ADMIN_USER;
  const password = env.STALWART_DEV_ADMIN_PASSWORD;
  return username && password ? ({ type: "basic", username, password } as const) : null;
}

function baseUrl(env: Record<string, string | undefined>): string {
  const url = env.STALWART_URL;
  if (!url) throw new Error("STALWART_URL is not set");
  return url;
}

/**
 * The management client for one credential (`keys.ts`), configured from the environment: its own key
 * (`STALWART_PROVISIONING_KEY`, `STALWART_OPERATIONS_KEY` or `STALWART_AUDIT_KEY`), or — outside production only —
 * the dev recovery admin (`STALWART_DEV_ADMIN_USER` / `_PASSWORD`), which stands in for all three in development.
 */
function forRole(role: StalwartCredentialRole): StalwartManagement {
  const cache = (globalForStalwart.amStalwart ??= {});
  const cached = cache[role];
  // `instanceof`: in development a reloaded module brings a new class, and an instance cached on `globalThis` by the
  // old one would lack methods added since (production never reloads, so this is always true there).
  if (cached instanceof StalwartManagement) return cached;
  const env = process.env;
  const c = SERVICE_CREDENTIALS[role];
  const problems = credentialEnvProblems([role], {
    NODE_ENV: env.NODE_ENV,
    [c.env]: env[c.env],
    STALWART_API_KEY: env.STALWART_API_KEY,
  });
  if (problems.length > 0) throw new Error(`Stalwart credential refused: ${problems.join("; ")}`);
  const token = env[c.env]?.trim();
  const auth =
    token !== undefined && token !== ""
      ? ({ type: "bearer", token } as const)
      : env.NODE_ENV === "production"
        ? null
        : devAdminAuth(env);
  if (!auth) throw new Error(`Set ${c.env} (or, in development, the dev admin credentials)`);
  const made = new StalwartManagement(new StalwartTransport({ baseUrl: baseUrl(env), auth }));
  cache[role] = made;
  return made;
}

/** Worker and scheduler: domains, accounts, DKIM; no owner access to any mailbox. */
export const stalwartProvisioning = (): StalwartManagement => forRole("provisioning");
/** Web: app passwords and the managed Sieve script; no account or domain changes. */
export const stalwartOperations = (): StalwartManagement => forRole("operations");
/** Scheduler: reads managed Sieve scripts for the reconciler, nothing else. */
export const stalwartAudit = (): StalwartManagement => forRole("audit");

/** Whether this process has a credential for `role` (its key, or the dev admin outside production). */
export function hasStalwartCredential(role: StalwartCredentialRole): boolean {
  const key = process.env[SERVICE_CREDENTIALS[role].env];
  if (key !== undefined && key.trim() !== "") return true;
  return process.env.NODE_ENV !== "production" && devAdminAuth(process.env) !== null;
}

/**
 * Development tooling only (seed, `stack:verify`, e2e fixtures, integration-test set-up): the dev recovery admin, with
 * every permission. Refused in production, where it is never configured.
 */
export function stalwartDevAdmin(): StalwartManagement {
  if (process.env.NODE_ENV === "production") throw new Error("The dev admin is never used in production");
  const cache = (globalForStalwart.amStalwart ??= {});
  if (cache.devAdmin instanceof StalwartManagement) return cache.devAdmin;
  const auth = devAdminAuth(process.env);
  if (!auth) throw new Error("Set STALWART_DEV_ADMIN_USER and STALWART_DEV_ADMIN_PASSWORD");
  cache.devAdmin = new StalwartManagement(new StalwartTransport({ baseUrl: baseUrl(process.env), auth }));
  return cache.devAdmin;
}

/**
 * Start-up scope check: asks Stalwart what `mgmt`'s key can do and throws unless it is exactly the documented set
 * (`credentialScopeProblems`) — a provisioning key that can impersonate, or an operations key that can write accounts,
 * stops the process. Skipped for the dev admin (it holds everything by design). Returns which kind was checked.
 */
export async function verifyStalwartCredential(
  role: StalwartCredentialRole,
  mgmt: StalwartManagement,
): Promise<"key" | "dev-admin"> {
  if (mgmt.transport.authType === "basic") return "dev-admin";
  const problems = credentialScopeProblems(role, await mgmt.credentialPermissions());
  if (problems.length > 0) throw new Error(`Stalwart credential refused: ${problems.join("; ")}`);
  return "key";
}
