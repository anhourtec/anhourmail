// SPDX-License-Identifier: MIT
/**
 * App passwords on Stalwart v0.16 (verified against the pinned v0.16.27; research/stalwart.md "App passwords").
 *
 * An app password is an `x:AppPassword` credential of one account: Stalwart generates the secret (`app_` + 36
 * lowercase letters and digits), returns it once from `/set`, and stores it hashed. Each credential carries its own
 * `permissions` (`Inherit`, or `Disable` with a set of the server's `Permission` names), which Stalwart enforces per
 * protocol: without `imapAuthenticate` an IMAP LOGIN is refused, without `emailSend` SMTP AUTH answers 550, without
 * the `dav*` permissions a CardDAV PROPFIND answers 403, without the `jmap*` ones every JMAP method is `forbidden`.
 *
 * `Inherit` would hand a mail app everything the account's role allows, which on the built-in User role includes the
 * self-service objects: changing the account password and minting more app passwords and API keys over JMAP with
 * nothing but the app password (verified). So every app password made here allows only its scopes' allow-lists
 * (`SCOPE_ALLOW`) and has every other known permission turned off (`appPasswordPermissions`). The customer account
 * itself also has the self-service objects, principal look-ups and sharing turned off (`CUSTOMER_DENIALS` in
 * `management.ts`), so neither an OAuth token nor the mailbox password reaches them either.
 *
 * The names come from the pinned server (`GET /api/schema`, `GET /api/account`). An upgrade re-checks them
 * (CLAUDE.md rule 22): the integration test fails if the server knows a permission that isn't classified here, or the
 * User role gains a self-service one.
 */

/** Self-service objects the User role grants: never for an end user, whatever signs in. */
export const SELF_SERVICE_PERMISSIONS = [
  "sysAccountPasswordGet",
  "sysAccountPasswordUpdate",
  "sysAccountSettingsGet",
  "sysAccountSettingsUpdate",
  "sysApiKeyCreate",
  "sysApiKeyDestroy",
  "sysApiKeyGet",
  "sysApiKeyQuery",
  "sysApiKeyUpdate",
  "sysAppPasswordCreate",
  "sysAppPasswordDestroy",
  "sysAppPasswordGet",
  "sysAppPasswordQuery",
  "sysAppPasswordUpdate",
  "sysArchivedItemCreate",
  "sysArchivedItemDestroy",
  "sysArchivedItemGet",
  "sysArchivedItemQuery",
  "sysArchivedItemUpdate",
  "sysMaskedEmailCreate",
  "sysMaskedEmailDestroy",
  "sysMaskedEmailGet",
  "sysMaskedEmailQuery",
  "sysMaskedEmailUpdate",
  "sysPublicKeyCreate",
  "sysPublicKeyDestroy",
  "sysPublicKeyGet",
  "sysPublicKeyQuery",
  "sysPublicKeyUpdate",
  "sysSpamTrainingSampleDestroy",
  "sysSpamTrainingSampleGet",
  "sysSpamTrainingSampleQuery",
  "sysSpamTrainingSampleUpdate",
] as const;

/**
 * Principal look-ups. `Principal/query` lists every account on the server for any signed-in user (verified: 44 on
 * the dev server) even though the User role doesn't list these permissions; turning them off closes it. Denied on
 * every customer account (`CUSTOMER_PERMISSIONS` in `management.ts`) and never allowed to an app password.
 */
export const PRINCIPAL_READ_PERMISSIONS = [
  "jmapPrincipalGet",
  "jmapPrincipalQuery",
  "jmapPrincipalChanges",
  "jmapPrincipalQueryChanges",
  "jmapPrincipalGetAvailability",
] as const;

const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== "");

/**
 * Every permission name on the pinned server except the administrative `sys*` ones (from `GET /api/schema`,
 * v0.16.27): what an app password could ever be granted through the account's role. App passwords turn off all of
 * these except their scope's allow-list, which is how a `Replace` allow-list behaves — but a `Replace` can only grant
 * what the caller itself holds, so it would need a management key that can read every mailbox (verified), while
 * turning permissions off needs nothing. The integration test fails when the server knows a name that isn't here.
 */
export const KNOWN_PERMISSIONS: readonly string[] = words(`
  actionClassifySpam actionInvalidateCaches actionInvalidateNegativeCaches actionPauseMtaQueue
  actionReloadBlockedIps actionReloadLookupStores actionReloadSettings actionReloadTlsCertificates
  actionResumeMtaQueue actionTroubleshootDmarc actionUpdateApps authenticate authenticateWithAlias
  calendarAlarmsSend calendarSchedulingReceive calendarSchedulingSend davCalAcl davCalCopy davCalDelete
  davCalFreeBusyQuery davCalGet davCalLock davCalMkCol davCalMove davCalMultiGet davCalPropFind davCalPropPatch
  davCalPut davCalQuery davCardAcl davCardCopy davCardDelete davCardGet davCardLock davCardMkCol davCardMove
  davCardMultiGet davCardPropFind davCardPropPatch davCardPut davCardQuery davExpandProperty davFileAcl
  davFileCopy davFileDelete davFileGet davFileLock davFileMkCol davFileMove davFilePropFind davFilePropPatch
  davFilePut davPrincipalAcl davPrincipalList davPrincipalMatch davPrincipalSearch davPrincipalSearchPropSet
  davSyncCollection emailReceive emailSend fetchAnyBlob imapAclGet imapAclSet imapAppend imapAuthenticate
  imapCapability imapCopy imapCreate imapDelete imapEnable imapExamine imapExpunge imapFetch imapId imapIdle
  imapList imapListRights imapLsub imapMove imapMyRights imapNamespace imapRename imapSearch imapSelect
  imapSort imapStatus imapStore imapSubscribe imapThread impersonate interactAi jmapAddressBookChanges
  jmapAddressBookCreate jmapAddressBookDestroy jmapAddressBookGet jmapAddressBookUpdate jmapBlobCopy
  jmapBlobGet jmapBlobLookup jmapBlobUpload jmapCalendarChanges jmapCalendarCreate jmapCalendarDestroy
  jmapCalendarEventChanges jmapCalendarEventCopy jmapCalendarEventCreate jmapCalendarEventDestroy
  jmapCalendarEventGet jmapCalendarEventNotificationChanges jmapCalendarEventNotificationCreate
  jmapCalendarEventNotificationDestroy jmapCalendarEventNotificationGet jmapCalendarEventNotificationQuery
  jmapCalendarEventNotificationQueryChanges jmapCalendarEventNotificationUpdate jmapCalendarEventParse
  jmapCalendarEventQuery jmapCalendarEventQueryChanges jmapCalendarEventUpdate jmapCalendarGet
  jmapCalendarUpdate jmapContactCardChanges jmapContactCardCopy jmapContactCardCreate jmapContactCardDestroy
  jmapContactCardGet jmapContactCardParse jmapContactCardQuery jmapContactCardQueryChanges
  jmapContactCardUpdate jmapCoreEcho jmapEmailChanges jmapEmailCopy jmapEmailCreate jmapEmailDestroy
  jmapEmailGet jmapEmailImport jmapEmailParse jmapEmailQuery jmapEmailQueryChanges jmapEmailSubmissionChanges
  jmapEmailSubmissionCreate jmapEmailSubmissionDestroy jmapEmailSubmissionGet jmapEmailSubmissionQuery
  jmapEmailSubmissionQueryChanges jmapEmailSubmissionUpdate jmapEmailUpdate jmapFileNodeChanges
  jmapFileNodeCopy jmapFileNodeCreate jmapFileNodeDestroy jmapFileNodeGet jmapFileNodeQuery
  jmapFileNodeQueryChanges jmapFileNodeUpdate jmapIdentityChanges jmapIdentityCreate jmapIdentityDestroy
  jmapIdentityGet jmapIdentityUpdate jmapMailboxChanges jmapMailboxCreate jmapMailboxDestroy jmapMailboxGet
  jmapMailboxQuery jmapMailboxQueryChanges jmapMailboxUpdate jmapParticipantIdentityChanges
  jmapParticipantIdentityCreate jmapParticipantIdentityDestroy jmapParticipantIdentityGet
  jmapParticipantIdentityUpdate jmapPrincipalChanges jmapPrincipalCreate jmapPrincipalDestroy jmapPrincipalGet
  jmapPrincipalGetAvailability jmapPrincipalQuery jmapPrincipalQueryChanges jmapPrincipalUpdate
  jmapPushSubscriptionCreate jmapPushSubscriptionDestroy jmapPushSubscriptionGet jmapPushSubscriptionUpdate
  jmapQuotaChanges jmapQuotaGet jmapQuotaQuery jmapQuotaQueryChanges jmapSearchSnippetGet
  jmapShareNotificationChanges jmapShareNotificationCreate jmapShareNotificationDestroy
  jmapShareNotificationGet jmapShareNotificationQuery jmapShareNotificationQueryChanges
  jmapShareNotificationUpdate jmapSieveScriptCreate jmapSieveScriptDestroy jmapSieveScriptGet
  jmapSieveScriptQuery jmapSieveScriptUpdate jmapSieveScriptValidate jmapThreadChanges jmapThreadGet
  jmapVacationResponseCreate jmapVacationResponseDestroy jmapVacationResponseGet jmapVacationResponseUpdate
  liveDeliveryTest liveMetrics liveTracing oAuthClientOverride oAuthClientRegistration pop3Authenticate
  pop3Dele pop3List pop3Retr pop3Stat pop3Uidl scimAccess sieveAuthenticate sieveCheckScript sieveDeleteScript
  sieveGetScript sieveHaveSpace sieveListScripts sievePutScript sieveRenameScript sieveSetActive
  taskAccountMaintenance taskAcmeRenewal taskCalendarAlarmEmail taskCalendarAlarmNotification
  taskCalendarItipMessage taskDestroyAccount taskDkimManagement taskDmarcReport taskDnsManagement
  taskIndexDocument taskIndexTrace taskMergeThreads taskRestoreArchivedItem taskSpamFilterMaintenance
  taskStoreMaintenance taskTenantMaintenance taskTlsReport taskUnindexDocument unlimitedRequests
  unlimitedUploads
`);

export type AppPasswordScope = "imap" | "pop3" | "smtp" | "jmap" | "dav";

const allow = (re: RegExp, except = /^$/): string[] => KNOWN_PERMISSIONS.filter((p) => re.test(p) && !except.test(p));

/**
 * What each scope allows (allow-lists; everything else known stays off). `authenticate` comes with every scope.
 * Never allowed: ACL and sharing changes (delegation is a console action), Sieve and vacation writes, principal
 * look-ups, sign-in by alias, sending calendar invitations or alarms by mail, and everything administrative.
 */
export const SCOPE_ALLOW: Readonly<Record<AppPasswordScope, readonly string[]>> = {
  imap: allow(/^imap/, /^imapAclSet$/),
  pop3: allow(/^pop3/),
  smtp: ["emailSend"],
  // Mail over HTTPS: reading, organising and sending, but not changing sender identities.
  jmap: [
    "emailSend",
    ...allow(
      /^jmap(Email|Mailbox|Thread|SearchSnippet|Quota|Blob|PushSubscription|CoreEcho)|^jmapIdentity(Get|Changes)$|^jmapVacationResponseGet$/,
      // No folder create/update over JMAP: `shareWith` rides on them (sharing isn't offered; IMAP CREATE still works).
      /^jmapBlobLookup$|^jmapMailbox(Create|Update)$/,
    ),
  ],
  // Contacts and calendars: CardDAV, CalDAV and their JMAP objects; no mail, files or principal search.
  dav: [
    ...allow(/^dav(Card|Cal)|^davSyncCollection$|^davExpandProperty$/, /Acl$/),
    // Books and calendars themselves are made over CardDAV/CalDAV (MKCOL); their JMAP create/update carries `shareWith`.
    ...allow(
      /^jmap(AddressBook|ContactCard|Calendar|ParticipantIdentity)/,
      /^jmap(AddressBook|Calendar)(Create|Update)$/,
    ),
  ],
};

/** The `permissions` value for a new app password allowed only `scopes`. */
export function appPasswordPermissions(scopes: readonly AppPasswordScope[]): {
  "@type": "Disable";
  permissions: Record<string, true>;
} {
  const allowed = new Set<string>(["authenticate", ...scopes.flatMap((s) => SCOPE_ALLOW[s])]);
  const off = new Set<string>([...SELF_SERVICE_PERMISSIONS, ...KNOWN_PERMISSIONS.filter((p) => !allowed.has(p))]);
  return { "@type": "Disable", permissions: Object.fromEntries([...off].sort().map((p) => [p, true] as const)) };
}

/** A `permissions` value as a comparable key: its type and its sorted names that are set (order-insensitive). */
const fingerprint = (permissions: unknown): string | null => {
  if (typeof permissions !== "object" || permissions === null) return null;
  const p = permissions as { "@type"?: unknown; permissions?: unknown };
  const names =
    typeof p.permissions === "object" && p.permissions !== null
      ? Object.entries(p.permissions as Record<string, unknown>)
          .filter(([, v]) => v === true)
          .map(([k]) => k)
          .sort()
      : [];
  return `${String(p["@type"])}:${names.join(",")}`;
};

/** Which scopes a credential's `permissions` value stands for, or null when it isn't one we make. */
export function scopesOf(permissions: unknown): AppPasswordScope[] | null {
  const want = fingerprint(permissions);
  if (want === null) return null;
  const all: AppPasswordScope[] = ["imap", "pop3", "smtp", "jmap", "dav"];
  for (let mask = 1; mask < 1 << all.length; mask++) {
    const scopes = all.filter((_, i) => (mask & (1 << i)) !== 0);
    if (fingerprint(appPasswordPermissions(scopes)) === want) return scopes;
  }
  return null;
}

/**
 * True for anything starting like a Stalwart app password (`app_`), whatever follows: Stalwart also accepts an app
 * password with a `$…` suffix (its one-time-code separator; verified), so the shape can't be checked any tighter.
 * Such a secret never goes to the OAuth sign-in: Stalwart would mint an account-wide token from it, without the
 * credential's turned-off permissions (verified).
 */
export const isAppPasswordSecret = (secret: string): boolean => /^app_/i.test(secret.trim());
