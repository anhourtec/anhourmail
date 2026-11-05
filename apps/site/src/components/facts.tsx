// SPDX-License-Identifier: AGPL-3.0-only
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  ACCOUNT_POLICY,
  ACT_AS,
  ADDONS,
  ALIAS_CREATIONS_PER_DAY,
  ALIAS_CREATIONS_PER_YEAR,
  ALIAS_YEAR_DAYS,
  aliasAllowance,
  ALIASES_PER_MAILBOX,
  APP_PASSWORDS_PER_MAILBOX,
  BREACHED_PASSWORD,
  BILLING,
  CARDDAV,
  BULK_MAIL,
  CLIENT_ENDPOINTS,
  DATA_EXPORT,
  DELEGATED_MAILBOXES_PER_PERSON,
  DELEGATES_PER_MAILBOX,
  CLIENT_USERNAME_HINT,
  customerDomainRecords,
  formatPrice,
  MAX_EXTRA_MAILBOXES,
  MAX_STORAGE_BLOCKS,
  HOSTS,
  INVITE_EMAILS_PER_DAY,
  INVITE_TTL_DAYS,
  EMAIL_VERIFICATION_HOURS,
  MAILBOX_DELETE_GRACE_DAYS,
  MAX_MAILBOXES,
  MAX_PEOPLE,
  PENDING_DOMAIN,
  PLATFORM_ADDRESS,
  PLAN_ORDER,
  PLANS,
  PRODUCT_DOMAIN,
  PUBLIC_PLATFORM,
  RECOVERY_CODES,
  REMOTE_IMAGES,
  SECOND_STEP_LIMITS,
  STEP_UP_MINUTES,
  SUPPORT_EMAIL,
  storageText,
  SUSPENSION_REASONS,
  TOTP,
  TRUST_TIERS,
  TRUSTED_DEVICE_DAYS,
  type TrustTier,
  WEBMAIL_ATTACHMENTS,
  WEBMAIL_HANDOFF,
  WEBMAIL_HTML,
  WEBMAIL_SIGNATURES,
} from "@anhourmail/shared";
import { AVATAR } from "@anhourmail/shared/profile";
import {
  IMPORT,
  IMPORT_BATCH_COLUMNS,
  IMPORT_BATCH_REQUIRED,
  IMPORT_BATCH_ROW_TEXT,
  IMPORT_BLOCKED_TEXT,
  IMPORT_SOURCE_PRESETS,
  type ImportBatchColumn,
} from "@anhourmail/shared/import";
import { MAIL_RULES } from "@anhourmail/shared/mail-rules";
import { ACCOUNT_SAFE_SENDERS, MAX_SENDER_ENTRIES } from "@anhourmail/shared/senders";
import { WEBMAIL_TEMPLATES } from "@anhourmail/shared/templates";

import { CopyButton } from "./copy-button";

/**
 * Docs components that render facts from @anhourmail/shared — the single source of truth (CLAUDE.md rule 32). The docs
 * publish the product's own names (`PUBLIC_PLATFORM`, anhourmail.com), never a deployment's `PLATFORM_DOMAIN`.
 * docs/public never hard-codes a hostname, port, price or limit; scripts/check-docs.mjs enforces it.
 */

const VALUES = {
  productDomain: PRODUCT_DOMAIN,
  // Anhourtec support access (packages/shared/src/platform.ts ACT_AS, ADR-0023).
  actAsMinutes: String(ACT_AS.minutes),
  actAsMaxHours: String(ACT_AS.maxMinutes / 60),
  appHost: HOSTS.app,
  webmailHost: HOSTS.webmail,
  imapHost: HOSTS.imap,
  smtpHost: HOSTS.smtp,
  mxHost: HOSTS.mx[0],
  usernameHint: CLIENT_USERNAME_HINT,
  refundWindowDays: String(BILLING.refundWindowDays),
  // Billing lifecycle (plans.ts BILLING; ADR-0029 §5, §6): customer policy, published.
  restrictedDays: String(BILLING.restrictedDays),
  heldReceiveDays: String(BILLING.heldReceiveDays),
  maxStorageBlocks: String(MAX_STORAGE_BLOCKS),
  maxExtraMailboxes: String(MAX_EXTRA_MAILBOXES),
  mailboxDeleteGraceDays: String(MAILBOX_DELETE_GRACE_DAYS),
  // Data export and account deletion (packages/shared/src/data-lifecycle.ts, ADR-0025).
  accountDeletionGraceDays: String(ACCOUNT_DELETION_GRACE_DAYS),
  dataExportKeepDays: String(DATA_EXPORT.keepDays),
  pendingDomainSetupDays: String(PENDING_DOMAIN.onMailServerDays),
  pendingDomainDays: String(PENDING_DOMAIN.unverifiedDays),
  inviteDays: String(INVITE_TTL_DAYS),
  inviteEmailsPerDay: String(INVITE_EMAILS_PER_DAY),
  // Alias creations per account per UTC day (packages/shared/src/plans.ts); deleting gives none back.
  aliasCreationsPerDayFree: String(ALIAS_CREATIONS_PER_DAY.free.alias),
  maskedCreationsPerDayFree: String(ALIAS_CREATIONS_PER_DAY.free.masked),
  aliasCreationsPerDayPaid: String(ALIAS_CREATIONS_PER_DAY.paid.alias),
  maskedCreationsPerDayPaid: String(ALIAS_CREATIONS_PER_DAY.paid.masked),
  // Free's yearly creation caps (rolling days) and the per-mailbox cap on every plan (plans.ts).
  aliasCreationsPerYearFree: String(ALIAS_CREATIONS_PER_YEAR.free.alias),
  maskedCreationsPerYearFree: String(ALIAS_CREATIONS_PER_YEAR.free.masked),
  aliasYearDays: String(ALIAS_YEAR_DAYS),
  aliasesPerMailbox: String(ALIASES_PER_MAILBOX),
  aliasesFree: String(PLANS.free.aliases ?? ALIASES_PER_MAILBOX),
  maskedAliasesFree: String(PLANS.free.maskedAliases ?? ALIASES_PER_MAILBOX),
  maxPeople: String(MAX_PEOPLE),
  // Mailbox delegation ceilings (plans.ts; ADR-0026).
  delegatesPerMailbox: String(DELEGATES_PER_MAILBOX),
  delegatedMailboxesPerPerson: String(DELEGATED_MAILBOXES_PER_PERSON),
  photoMaxUpload: `${String(AVATAR.maxUploadMb)} MB`,
  // Free platform addresses (packages/shared/src/addresses.ts, plans.ts; ADR-0021)
  platformAddressMin: String(PLATFORM_ADDRESS.min),
  platformAddressMax: String(PLATFORM_ADDRESS.max),
  freePlatformAddresses: String(PLANS.free.platformMailboxes ?? MAX_MAILBOXES),
  maxMailboxes: String(MAX_MAILBOXES),
  emailVerificationHours: String(EMAIL_VERIFICATION_HOURS),
  freeStorage: `${String(PLANS.free.storagePoolGb)} GB`,
  plusStorage: `${String(PLANS.plus.storagePoolGb)} GB`,
  includedMailboxes: String(PLANS.plus.includedMailboxes),
  storageBlock: `${String(PLANS.plus.storageBlockGb ?? 0)} GB`,
  storageBlockPrice: PLANS.plus.storageBlockPrice ? formatPrice(PLANS.plus.storageBlockPrice.USD, "USD") : "",
  extraMailboxPrice: PLANS.plus.extraMailboxPrice ? formatPrice(PLANS.plus.extraMailboxPrice.USD, "USD") : "",
  // Published now, enforced in Phase 6 (packages/shared/src/plans.ts ACCOUNT_POLICY).
  freeDailyExternal: String(ACCOUNT_POLICY.externalRecipientsPerDay.free),
  paidDailyExternal: String(ACCOUNT_POLICY.externalRecipientsPerDay.paid),
  newAccountDays: String(ACCOUNT_POLICY.newAccountDays),
  sendMessageSize: `${String(ACCOUNT_POLICY.sendMessageMb)} MB`,
  receiveMessageSize: `${String(ACCOUNT_POLICY.receiveMessageMb)} MB`,
  freeInactivityMonths: String(ACCOUNT_POLICY.freeInactivityMonths),
  inactiveMailKeptDays: String(ACCOUNT_POLICY.inactiveMailKeptDays),
  plusPriceUsd: PLANS.plus.price ? formatPrice(PLANS.plus.price.USD, "USD") : "",
  plusPriceCad: PLANS.plus.price ? formatPrice(PLANS.plus.price.CAD, "CAD") : "",
  supporterMinUsd: PLANS.supporter.price ? formatPrice(PLANS.supporter.price.USD, "USD") : "",
  newDailyLimit: String(TRUST_TIERS.new.limits.messagesPerDay),
  // Webmail recipients per message: every mailbox sends on the `new` tier until trust tiers are stored per account.
  recipientsPerMessage: String(TRUST_TIERS.new.limits.recipientsPerMessage),
  carddavHost: CARDDAV.host,
  carddavUrl: CARDDAV.url,
  attachmentPerFile: `${String(WEBMAIL_ATTACHMENTS.perFileMb)} MB`,
  attachmentPerMessage: `${String(WEBMAIL_ATTACHMENTS.perMessageMb)} MB`,
  htmlMaxSize: `${String(WEBMAIL_HTML.maxMb)} MB`,
  htmlInlineImage: `${String(WEBMAIL_HTML.inlineImageKb)} KB`,
  signaturesPerMailbox: String(WEBMAIL_SIGNATURES.perMailbox),
  signatureNameChars: String(WEBMAIL_SIGNATURES.nameChars),
  signatureImages: String(WEBMAIL_SIGNATURES.imagesPerSignature),
  signatureImageSize: `${String(WEBMAIL_SIGNATURES.imageKb)} KB`,
  signatureMaxSize: `${String(WEBMAIL_SIGNATURES.signatureKb)} KB`,
  signaturesMaxSize: `${String(WEBMAIL_SIGNATURES.mailboxKb / 1024)} MB`,
  // Remote images through the webmail's image proxy (packages/shared/src/webmail.ts)
  remoteImageSize: `${String(REMOTE_IMAGES.maxMb)} MB`,
  remoteImagesPerMessage: String(REMOTE_IMAGES.perMessage),
  remoteImageSenders: String(REMOTE_IMAGES.maxSenders),
  // Blocked and Safe senders in webmail settings, each (packages/shared/src/senders.ts)
  senderListEntries: String(MAX_SENDER_ENTRIES),
  // The account-wide Safe senders list (packages/shared/src/senders.ts, ADR-0032 §1)
  accountSafeSenderEntries: String(ACCOUNT_SAFE_SENDERS.maxEntries),
  // Mail rules (packages/shared/src/mail-rules.ts, ADR-0032 §2)
  mailRulesPerMailbox: String(MAIL_RULES.maxRules),
  mailRuleConditions: String(MAIL_RULES.maxConditions),
  mailRuleValueChars: String(MAIL_RULES.valueChars),
  // Templates (packages/shared/src/templates.ts, ADR-0032 §3)
  templatesPerMailbox: String(WEBMAIL_TEMPLATES.perMailbox),
  templateNameChars: String(WEBMAIL_TEMPLATES.nameChars),
  templateMaxSize: `${String(WEBMAIL_TEMPLATES.templateKb)} KB`,
  bulkAddOnName: ADDONS[BULK_MAIL.addOnId].name,
  bulkAddOnStatus: ADDONS[BULK_MAIL.addOnId].status === "planned" ? "coming later" : "available now",
  bulkAddOnPlans: ADDONS[BULK_MAIL.addOnId].requires.map((id) => PLANS[id].name).join(" and "),
  // Console sign-in security (packages/shared/src/security.ts)
  totpDigits: String(TOTP.digits),
  recoveryCodeCount: String(RECOVERY_CODES.count),
  recoveryCodeWarnAt: String(RECOVERY_CODES.warnAtOrBelow),
  trustedDeviceDays: String(TRUSTED_DEVICE_DAYS),
  secondStepLockMinutes: String(SECOND_STEP_LIMITS.lockMinutes),
  // App passwords (packages/shared/src/security.ts)
  appPasswordsPerMailbox: String(APP_PASSWORDS_PER_MAILBOX),
  // Console → webmail handoff (packages/shared/src/webmail.ts, ADR-0024): how long the one-time link works
  webmailHandoffSeconds: String(WEBMAIL_HANDOFF.codeSec),
  // Breached-password check (packages/shared/src/security.ts)
  breachedPasswordMessage: BREACHED_PASSWORD.message,
  stepUpMinutes: String(STEP_UP_MINUTES),
  // Contacts import per file in the webmail (packages/shared/src/import.ts, ADR-0030 §10)
  contactsImportMaxSize: `${String(Math.round(IMPORT.contactsMaxBytes / (1024 * 1024)))} MB`,
  contactsImportMaxCards: IMPORT.contactsMaxCards.toLocaleString("en-CA"),
  // Mail import (packages/shared/src/import.ts, ADR-0030): published limits, never capacity settings.
  importMaxMessageSize: `${String(Math.round(IMPORT.maxMessageBytes / (1000 * 1000)))} MB`,
  importConcurrency: String(IMPORT.perAccountConcurrency),
  importSyncDays: String(IMPORT.syncWindowDays),
  importSyncEveryMinutes: String(IMPORT.syncEveryMinutes),
  importBatchMaxSize: `${String(IMPORT.batchMaxBytes / 1024)} KB`,
  importPortTls: String(IMPORT.sourcePorts[0]),
  importPortStartTls: String(IMPORT.sourcePorts[1]),
  importDefaultPort: String(IMPORT.defaultSourcePort),
  // Where to write for help and to appeal a suspension (packages/shared/src/platform.ts)
  supportEmail: SUPPORT_EMAIL,
} as const;

export type FactKey = keyof typeof VALUES;

/** Inline fact, e.g. `<Value of="imapHost" />`. Hostnames render in mono. */
export function Value({ of, copy = false }: { of: FactKey; copy?: boolean }) {
  const v = VALUES[of];
  const mono =
    of.endsWith("Host") ||
    of.endsWith("Url") ||
    of.startsWith("importPort") ||
    of === "importDefaultPort" ||
    of === "productDomain" ||
    of === "supportEmail";
  return (
    <span className="inline-flex items-center gap-0.5 align-baseline">
      {mono ? <code>{v}</code> : <span>{v}</span>}
      {copy ? <CopyButton value={v} label={of} /> : null}
    </span>
  );
}

function Cell({ value, label, wrap = false }: { value: string; label: string; wrap?: boolean }) {
  return (
    <td className="py-2 pr-2 align-middle">
      <span className="inline-flex items-center gap-1">
        <code className={wrap ? "break-all" : "whitespace-nowrap"}>{value}</code>
        <CopyButton value={value} label={label} />
      </span>
    </td>
  );
}

/** Incoming / outgoing server settings for mail apps. */
export function ClientSettingsTable() {
  return (
    <div className="not-prose overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-fd-muted-foreground">
            <th className="py-2 pr-4 font-medium">Protocol</th>
            <th className="py-2 pr-4 font-medium">Server</th>
            <th className="py-2 pr-4 font-medium">Port</th>
            <th className="py-2 pr-4 font-medium">Security</th>
          </tr>
        </thead>
        <tbody>
          {CLIENT_ENDPOINTS.map((e) => (
            <tr key={`${e.protocol}-${e.port}`} className="border-b last:border-0">
              <td className="py-2 pr-4">
                {e.protocol}
                {e.recommended ? <span className="ml-2 text-fd-muted-foreground text-xs">recommended</span> : null}
              </td>
              <Cell value={e.host} label={`${e.protocol} server`} />
              <Cell value={String(e.port)} label={`${e.protocol} port`} />
              <td className="py-2 pr-4">{e.security}</td>
            </tr>
          ))}
          <tr>
            <td className="py-2 pr-4">Username</td>
            <td className="py-2 pr-4" colSpan={3}>
              {CLIENT_USERNAME_HINT}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** The DNS records a custom domain needs, rendered for `domain`. Each value has a copy button. */
export function DnsRecordTable({ domain = "example.com" }: { domain?: string }) {
  const records = customerDomainRecords(domain, "your-verification-code", PUBLIC_PLATFORM);
  return (
    <div className="not-prose overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-fd-muted-foreground">
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 font-medium">Value</th>
            <th className="py-2 pr-4 font-medium">Priority</th>
            <th className="py-2 pr-4 font-medium">Needed</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={`${r.type}-${r.name}-${r.value}`} className="border-b align-top last:border-0">
              <td className="py-2 pr-4 font-mono">{r.type}</td>
              <Cell value={r.name} label={`${r.type} name`} />
              <Cell value={r.value} label={`${r.type} value`} wrap />
              <td className="py-2 pr-4">{r.priority ?? "—"}</td>
              <td className="py-2 pr-4">
                <span className="block">{r.required ? "Required" : "Recommended"}</span>
                <span className="block text-fd-muted-foreground text-xs">{r.why}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * While paid plans aren't open (`BILLING.status` planned, ADR-0029 §3) the billing guide says so at the top; the launch
 * change that opens them removes the note with no edit to the docs.
 */
export function BillingStatusNote() {
  if (BILLING.status !== "planned") return null;
  return (
    <div role="note" className="my-4 rounded-lg border px-4 py-3 text-[14px]">
      Paid plans aren&apos;t open yet. Until they are, every account stays on the plan it has now and nothing can be
      bought; this page describes how billing works once it opens.
    </div>
  );
}

/** Plans with prices and limits. */
export function PlanTable() {
  return (
    <div className="not-prose overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-fd-muted-foreground">
            <th className="py-2 pr-4 font-medium">Plan</th>
            <th className="py-2 pr-4 font-medium">Price per year</th>
            <th className="py-2 pr-4 font-medium">Storage per account</th>
            <th className="py-2 pr-4 font-medium">Mailboxes included</th>
            <th className="py-2 pr-4 font-medium">@{PRODUCT_DOMAIN} addresses</th>
            <th className="py-2 pr-4 font-medium">Custom domains</th>
            <th className="py-2 pr-4 font-medium">Aliases</th>
            <th className="py-2 pr-4 font-medium">Masked aliases</th>
          </tr>
        </thead>
        <tbody>
          {PLAN_ORDER.map((id) => {
            const p = PLANS[id];
            const price = p.price
              ? `${p.payWhatYouWant ? "From " : ""}${formatPrice(p.price.USD, "USD")} USD / ${formatPrice(p.price.CAD, "CAD")} CAD`
              : "Free";
            return (
              <tr key={id} className="border-b last:border-0">
                <td className="py-2 pr-4 font-medium">{p.name}</td>
                <td className="py-2 pr-4">{price}</td>
                <td className="py-2 pr-4">{p.storagePoolGb} GB</td>
                <td className="py-2 pr-4">{p.includedMailboxes}</td>
                <td className="py-2 pr-4">{p.platformMailboxes ?? `Up to ${String(MAX_MAILBOXES)}`}</td>
                <td className="py-2 pr-4">{p.customDomains ? "Yes" : "No"}</td>
                <td className="py-2 pr-4">{aliasAllowance(p).aliases}</td>
                <td className="py-2 pr-4">{aliasAllowance(p).maskedAliases}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-fd-muted-foreground text-sm">
        {PLANS.plus.name} and {PLANS.supporter.name}: {storageText(PLANS.plus).pool}. {storageText(PLANS.plus).block}.{" "}
        {storageText(PLANS.plus).extraMailbox}.
      </p>
    </div>
  );
}

const TIER_ORDER: readonly TrustTier[] = ["new", "standard", "trusted", "restricted"];

/** Published sending limits per trust tier (never the detection rules behind them). */
export function SendLimitsTable() {
  return (
    <div className="not-prose overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-fd-muted-foreground">
            <th className="py-2 pr-4 font-medium">Level</th>
            <th className="py-2 pr-4 font-medium">Per day</th>
            <th className="py-2 pr-4 font-medium">Per hour</th>
            <th className="py-2 pr-4 font-medium">Recipients per message</th>
            <th className="py-2 pr-4 font-medium">Who</th>
          </tr>
        </thead>
        <tbody>
          {TIER_ORDER.map((t) => {
            const info = TRUST_TIERS[t];
            return (
              <tr key={t} className="border-b align-top last:border-0">
                <td className="py-2 pr-4 font-medium">{info.label}</td>
                <td className="py-2 pr-4">{info.limits.messagesPerDay}</td>
                <td className="py-2 pr-4">{info.limits.messagesPerHour}</td>
                <td className="py-2 pr-4">{info.limits.recipientsPerMessage}</td>
                <td className="py-2 pr-4 text-fd-muted-foreground">{info.description}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The reason categories a suspension notice can give, in the words customers see (`SUSPENSION_REASONS`). */
export function SuspensionReasonList() {
  return (
    <ul>
      {Object.values(SUSPENSION_REASONS).map((label) => (
        <li key={label}>{label}</li>
      ))}
    </ul>
  );
}

// ---- mail import (packages/shared/src/import.ts, ADR-0030) ----------------------------------------------------

/**
 * The old provider's IMAP settings for the console's provider choices, each copyable. `preset` shows one provider
 * (its guide); without it, every named provider ("Other IMAP server" has no fixed host and is left out).
 */
export function ImportServerTable({ preset }: { preset?: string }) {
  const rows = IMPORT_SOURCE_PRESETS.filter((p) => p.host !== null && (preset === undefined || p.id === preset));
  return (
    <div className="not-prose overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-fd-muted-foreground">
            <th className="py-2 pr-4 font-medium">Provider</th>
            <th className="py-2 pr-4 font-medium">IMAP server</th>
            <th className="py-2 pr-4 font-medium">Port</th>
            <th className="py-2 pr-4 font-medium">User name</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-b last:border-0">
              <td className="py-2 pr-4">{p.name}</td>
              <Cell value={p.host ?? ""} label={`${p.name} IMAP server`} />
              <Cell value={String(p.port)} label={`${p.name} IMAP port`} />
              <td className="py-2 pr-4">{p.usernameHint}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-fd-muted-foreground text-sm">
        Choosing the provider in the console fills these in for you. The connection is always encrypted (TLS).
      </p>
    </div>
  );
}

/** Why an import says "Needs you", and what fixes it, in the console's own words (`IMPORT_BLOCKED_TEXT`). */
export function ImportBlockedList() {
  return (
    <ul>
      {Object.entries(IMPORT_BLOCKED_TEXT).map(([reason, { title, fix }]) => (
        <li key={reason}>
          <strong>{title}.</strong> {fix}
        </li>
      ))}
    </ul>
  );
}

const BATCH_COLUMN_TEXT: Readonly<Record<ImportBatchColumn, string>> = {
  mailbox: "The address of the mailbox here that the mail goes into. It must already exist in your account.",
  source_host: "The old provider's IMAP server.",
  source_port: `${String(IMPORT.sourcePorts[0])} (TLS) or ${String(IMPORT.sourcePorts[1])} (STARTTLS). Empty means ${String(IMPORT.defaultSourcePort)}.`,
  source_username: "The user name for the old mailbox, usually its full email address.",
  source_password: "An app password made at the old provider for this import.",
  exclude_junk_trash: "Leave out Junk and Deleted items: yes or no. Empty means yes.",
  sync: "Keep copying new mail until you stop it: yes or no. Empty means no.",
};

/** The columns of the admins' batch CSV (`IMPORT_BATCH_COLUMNS`), in the template's order. */
export function ImportBatchColumnsTable() {
  return (
    <div className="not-prose overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-fd-muted-foreground">
            <th className="py-2 pr-4 font-medium">Column</th>
            <th className="py-2 pr-4 font-medium">Needed</th>
            <th className="py-2 pr-4 font-medium">What goes in it</th>
          </tr>
        </thead>
        <tbody>
          {IMPORT_BATCH_COLUMNS.map((c) => (
            <tr key={c} className="border-b align-top last:border-0">
              <td className="py-2 pr-4">
                <code className="whitespace-nowrap">{c}</code>
              </td>
              <td className="py-2 pr-4">{IMPORT_BATCH_REQUIRED.includes(c) ? "Required" : "Optional"}</td>
              <td className="py-2 pr-4 text-fd-muted-foreground">{BATCH_COLUMN_TEXT[c]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Why a batch row didn't start, in the console's own words (`IMPORT_BATCH_ROW_TEXT`). */
export function ImportBatchRowList() {
  return (
    <ul>
      {Object.entries(IMPORT_BATCH_ROW_TEXT).map(([code, text]) => (
        <li key={code}>{text}.</li>
      ))}
    </ul>
  );
}
