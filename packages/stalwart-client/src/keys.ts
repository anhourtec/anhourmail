// SPDX-License-Identifier: MIT
/**
 * The control plane's Stalwart credentials (ADR-0020 "Credential split"; verified on the pinned v0.16.27,
 * 2026-10-22/23). Three scoped API keys, each owned by its own service account, so no single credential both creates
 * accounts and reads mail. This split alone is not the whole control: any key that can update accounts
 * (`sysAccountUpdate`, held by the provisioning key) can set a *password* on an account — a customer's (then sign in
 * as them) or `svc-ops`/`svc-audit` (then sign in with that key's `impersonate`, including the `<mailbox>%<account>`
 * master-user form, even on the mail ports — verified). Stalwart (Community) has no setting to forbid that, so in
 * production an internal **management proxy** refuses any `x:Account/set` that writes a `credentials` value and any
 * `x:AppPassword/set` on a service account (ops repo), and the reconciler reports a password or app password that
 * slips onto a service account and a mailbox without exactly one Password credential. The keys:
 *
 * - **provisioning** (worker, scheduler): domains, accounts, DKIM keys. Stalwart lets a credential assign only
 *   permissions it holds itself, measured against what the new account would end up with (its role minus
 *   `disabledPermissions`), so this key also holds every permission a customer mailbox keeps (`USER_ROLE_PERMISSIONS`
 *   minus `CUSTOMER_PERMISSIONS`' denials). Disabling needs nothing. It has **no `impersonate`**: on another account
 *   `Email/query`, `Mailbox/get`, `Blob/get`, `SieveScript/get` and `x:AppPassword/*` are `forbidden`, and a known
 *   blob id downloads as 404 (verified). App passwords are listed and revoked through `x:Account.credentials`.
 * - **operations** (web): app passwords and the managed Sieve script on a mailbox (`impersonate` + those objects, no
 *   mail objects). No `x:Account`, `x:Domain` or DKIM access at all.
 * - **audit** (scheduler): reads the managed Sieve scripts for the hourly reconciler (`impersonate`, Sieve and blob
 *   reads only — it can't write a script, create a credential or list mail).
 *
 * Each key is `Replace`-typed with exactly its set below, and is also capped by its account's role (a key on a
 * User-role account with `sysDomainGet` answered `forbidden`, verified), so the service accounts get a custom role
 * equal to the key's set (`service-accounts.ts`) rather than the Admin role: so if a password is ever set on such an
 * account despite the proxy, the sign-in has the key's permissions, not an administrator's.
 */
import { CUSTOMER_PERMISSIONS } from "./management";

const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== "");
const unique = (names: readonly string[]): readonly string[] => [...new Set(names)].sort();
const objectVerbs = (object: string): string[] =>
  ["Get", "Create", "Update", "Destroy", "Query"].map((v) => `sys${object}${v}`);

/**
 * Every permission the built-in User role grants on the pinned server (`GET /api/account` signed in as a fresh
 * User-role account with `Inherit` permissions: 239 names). The integration test fails when an upgrade changes it.
 */
export const USER_ROLE_PERMISSIONS: readonly string[] = words(`
  authenticate authenticateWithAlias calendarAlarmsSend calendarSchedulingReceive calendarSchedulingSend davCalAcl
  davCalCopy davCalDelete davCalFreeBusyQuery davCalGet davCalLock davCalMkCol davCalMove davCalMultiGet
  davCalPropFind davCalPropPatch davCalPut davCalQuery davCardAcl davCardCopy davCardDelete davCardGet davCardLock
  davCardMkCol davCardMove davCardMultiGet davCardPropFind davCardPropPatch davCardPut davCardQuery
  davExpandProperty davFileAcl davFileCopy davFileDelete davFileGet davFileLock davFileMkCol davFileMove
  davFilePropFind davFilePropPatch davFilePut davPrincipalAcl davPrincipalList davPrincipalMatch davPrincipalSearch
  davPrincipalSearchPropSet davSyncCollection emailReceive emailSend imapAclGet imapAclSet imapAppend
  imapAuthenticate imapCapability imapCopy imapCreate imapDelete imapEnable imapExamine imapExpunge imapFetch imapId
  imapIdle imapList imapListRights imapLsub imapMove imapMyRights imapNamespace imapRename imapSearch imapSelect
  imapSort imapStatus imapStore imapSubscribe imapThread interactAi jmapAddressBookChanges jmapAddressBookCreate
  jmapAddressBookDestroy jmapAddressBookGet jmapAddressBookUpdate jmapBlobCopy jmapBlobGet jmapBlobLookup
  jmapBlobUpload jmapCalendarChanges jmapCalendarCreate jmapCalendarDestroy jmapCalendarEventChanges
  jmapCalendarEventCopy jmapCalendarEventCreate jmapCalendarEventDestroy jmapCalendarEventGet
  jmapCalendarEventNotificationChanges jmapCalendarEventNotificationCreate jmapCalendarEventNotificationDestroy
  jmapCalendarEventNotificationGet jmapCalendarEventNotificationQuery jmapCalendarEventNotificationQueryChanges
  jmapCalendarEventNotificationUpdate jmapCalendarEventParse jmapCalendarEventQuery jmapCalendarEventQueryChanges
  jmapCalendarEventUpdate jmapCalendarGet jmapCalendarUpdate jmapContactCardChanges jmapContactCardCopy
  jmapContactCardCreate jmapContactCardDestroy jmapContactCardGet jmapContactCardParse jmapContactCardQuery
  jmapContactCardQueryChanges jmapContactCardUpdate jmapCoreEcho jmapEmailChanges jmapEmailCopy jmapEmailCreate
  jmapEmailDestroy jmapEmailGet jmapEmailImport jmapEmailParse jmapEmailQuery jmapEmailQueryChanges
  jmapEmailSubmissionChanges jmapEmailSubmissionCreate jmapEmailSubmissionDestroy jmapEmailSubmissionGet
  jmapEmailSubmissionQuery jmapEmailSubmissionQueryChanges jmapEmailSubmissionUpdate jmapEmailUpdate
  jmapFileNodeChanges jmapFileNodeCopy jmapFileNodeCreate jmapFileNodeDestroy jmapFileNodeGet jmapFileNodeQuery
  jmapFileNodeQueryChanges jmapFileNodeUpdate jmapIdentityChanges jmapIdentityCreate jmapIdentityDestroy
  jmapIdentityGet jmapIdentityUpdate jmapMailboxChanges jmapMailboxCreate jmapMailboxDestroy jmapMailboxGet
  jmapMailboxQuery jmapMailboxQueryChanges jmapMailboxUpdate jmapParticipantIdentityChanges
  jmapParticipantIdentityCreate jmapParticipantIdentityDestroy jmapParticipantIdentityGet
  jmapParticipantIdentityUpdate jmapPrincipalCreate jmapPrincipalDestroy jmapPrincipalUpdate
  jmapPushSubscriptionCreate jmapPushSubscriptionDestroy jmapPushSubscriptionGet jmapPushSubscriptionUpdate
  jmapQuotaChanges jmapQuotaGet jmapQuotaQuery jmapQuotaQueryChanges jmapSearchSnippetGet
  jmapShareNotificationChanges jmapShareNotificationCreate jmapShareNotificationDestroy jmapShareNotificationGet
  jmapShareNotificationQuery jmapShareNotificationQueryChanges jmapShareNotificationUpdate jmapSieveScriptCreate
  jmapSieveScriptDestroy jmapSieveScriptGet jmapSieveScriptQuery jmapSieveScriptUpdate jmapSieveScriptValidate
  jmapThreadChanges jmapThreadGet jmapVacationResponseCreate jmapVacationResponseDestroy jmapVacationResponseGet
  jmapVacationResponseUpdate pop3Authenticate pop3Dele pop3List pop3Retr pop3Stat pop3Uidl sieveAuthenticate
  sieveCheckScript sieveDeleteScript sieveGetScript sieveHaveSpace sieveListScripts sievePutScript sieveRenameScript
  sieveSetActive sysAccountPasswordGet sysAccountPasswordUpdate sysAccountSettingsGet sysAccountSettingsUpdate
  sysApiKeyCreate sysApiKeyDestroy sysApiKeyGet sysApiKeyQuery sysApiKeyUpdate sysAppPasswordCreate
  sysAppPasswordDestroy sysAppPasswordGet sysAppPasswordQuery sysAppPasswordUpdate sysArchivedItemCreate
  sysArchivedItemDestroy sysArchivedItemGet sysArchivedItemQuery sysArchivedItemUpdate sysMaskedEmailCreate
  sysMaskedEmailDestroy sysMaskedEmailGet sysMaskedEmailQuery sysMaskedEmailUpdate sysPublicKeyCreate
  sysPublicKeyDestroy sysPublicKeyGet sysPublicKeyQuery sysPublicKeyUpdate sysSpamTrainingSampleDestroy
  sysSpamTrainingSampleGet sysSpamTrainingSampleQuery sysSpamTrainingSampleUpdate
`);

/** What a customer mailbox keeps: the User role minus `CUSTOMER_PERMISSIONS`' denials (186 names on v0.16.27). */
export const CUSTOMER_EFFECTIVE_PERMISSIONS: readonly string[] = unique(
  USER_ROLE_PERMISSIONS.filter((p) => !(p in CUSTOMER_PERMISSIONS.disabledPermissions)),
);

/** Worker and scheduler: directory, DKIM, and the permissions it hands to customer mailboxes. No `impersonate`. */
export const PROVISIONING_KEY_PERMISSIONS: readonly string[] = unique([
  "authenticate",
  ...objectVerbs("Domain"),
  ...objectVerbs("Account"),
  ...objectVerbs("DkimSignature"),
  ...CUSTOMER_EFFECTIVE_PERMISSIONS,
]);

/** Web: app passwords on a mailbox and the managed Sieve script. No account, domain or mail objects. */
export const OPERATIONS_KEY_PERMISSIONS: readonly string[] = unique([
  "authenticate",
  "impersonate",
  "sysAppPasswordCreate",
  "sysAppPasswordGet",
  "sysAppPasswordQuery",
  "sysAppPasswordDestroy",
  "sysApiKeyGet",
  "sysApiKeyQuery",
  "jmapSieveScriptGet",
  "jmapSieveScriptQuery",
  "jmapSieveScriptCreate",
  "jmapSieveScriptUpdate",
  "jmapSieveScriptValidate",
  "jmapBlobUpload",
  "jmapBlobGet",
]);

/** Scheduler: reads managed Sieve scripts (the reconciler's redirect check). Nothing else. */
export const AUDIT_KEY_PERMISSIONS: readonly string[] = unique([
  "authenticate",
  "impersonate",
  "jmapSieveScriptGet",
  "jmapSieveScriptQuery",
  "jmapBlobGet",
]);

export type StalwartCredentialRole = "provisioning" | "operations" | "audit";

export type ServiceCredential = {
  /** The service account's name (local part, on the deployment's system domain). */
  account: string;
  /** The environment variable that carries the key, in exactly the containers listed in `usedBy`. */
  env: string;
  usedBy: string;
  permissions: readonly string[];
};

export const SERVICE_CREDENTIALS: Readonly<Record<StalwartCredentialRole, ServiceCredential>> = {
  provisioning: {
    account: "svc-provision",
    env: "STALWART_PROVISIONING_KEY",
    usedBy: "worker and scheduler",
    permissions: PROVISIONING_KEY_PERMISSIONS,
  },
  operations: {
    account: "svc-ops",
    env: "STALWART_OPERATIONS_KEY",
    usedBy: "web",
    permissions: OPERATIONS_KEY_PERMISSIONS,
  },
  audit: { account: "svc-audit", env: "STALWART_AUDIT_KEY", usedBy: "scheduler", permissions: AUDIT_KEY_PERMISSIONS },
};

export const CREDENTIAL_ROLES = Object.keys(SERVICE_CREDENTIALS) as StalwartCredentialRole[];

/** The account of the single management key of earlier versions (Admin role); deployments retire it. */
export const LEGACY_SERVICE_ACCOUNT = "svc-mgmt";

/** The single management key of earlier versions; refused everywhere so a stale setting can't linger unused. */
export const LEGACY_KEY_ENV = "STALWART_API_KEY";
const DEV_ADMIN_ENV = ["STALWART_DEV_ADMIN_USER", "STALWART_DEV_ADMIN_PASSWORD"] as const;

const present = (v: string | undefined): boolean => v !== undefined && v.trim() !== "";

/**
 * Start-up check of a process's Stalwart settings: `roles` are the credentials this process uses, `optional` ones it
 * may be given (a one-off job in the worker container may run without the scheduler's audit key). In production each
 * of `roles` must be set and no other credential may be present (the web app can't create accounts, the worker can't
 * act inside a mailbox), and the dev recovery admin must not be configured. The legacy single key is refused
 * everywhere. Returns the problems (setting names only, never values).
 */
export function credentialEnvProblems(
  roles: readonly StalwartCredentialRole[],
  env: Record<string, string | undefined>,
  optional: readonly StalwartCredentialRole[] = [],
): string[] {
  const problems: string[] = [];
  if (present(env[LEGACY_KEY_ENV])) {
    problems.push(
      `${LEGACY_KEY_ENV} is no longer used: set ${roles.map((r) => SERVICE_CREDENTIALS[r].env).join(" / ")} instead`,
    );
  }
  if (env.NODE_ENV !== "production") return problems;
  for (const role of CREDENTIAL_ROLES) {
    const c = SERVICE_CREDENTIALS[role];
    if (roles.includes(role) && !present(env[c.env])) problems.push(`${c.env} must be set in production`);
    if (!roles.includes(role) && !optional.includes(role) && present(env[c.env])) {
      problems.push(`${c.env} must not be given to this process (only to the ${c.usedBy})`);
    }
  }
  for (const k of DEV_ADMIN_ENV) if (present(env[k])) problems.push(`${k} is for development only`);
  return problems;
}

/**
 * Compares what a key can do (`GET /api/account` with it) with its documented set: anything extra (an `impersonate` on
 * the provisioning key, account writes on the operations key) or missing is a problem. Names only, never secrets.
 */
export function credentialScopeProblems(role: StalwartCredentialRole, held: readonly string[]): string[] {
  const want = new Set(SERVICE_CREDENTIALS[role].permissions);
  const have = new Set(held);
  const extra = [...have].filter((p) => !want.has(p)).sort();
  const missing = [...want].filter((p) => !have.has(p)).sort();
  const list = (names: string[]) =>
    `${names.slice(0, 8).join(", ")}${names.length > 8 ? ` and ${String(names.length - 8)} more` : ""}`;
  const out: string[] = [];
  const env = SERVICE_CREDENTIALS[role].env;
  if (extra.length > 0) out.push(`${env} holds permissions outside its set: ${list(extra)}`);
  if (missing.length > 0) out.push(`${env} lacks permissions of its set: ${list(missing)}`);
  return out;
}
