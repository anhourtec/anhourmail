// SPDX-License-Identifier: AGPL-3.0-only
import {
  ADDONS,
  APP_PASSWORDS_PER_MAILBOX,
  BILLING,
  CARDDAV,
  BULK_MAIL,
  CLIENT_ENDPOINTS,
  CLIENT_USERNAME_HINT,
  customerDomainRecords,
  formatPrice,
  HOSTS,
  INVITE_EMAILS_PER_DAY,
  INVITE_TTL_DAYS,
  MAILBOX_DELETE_GRACE_DAYS,
  MAX_PEOPLE,
  PLAN_ORDER,
  PLANS,
  PRODUCT_DOMAIN,
  PUBLIC_PLATFORM,
  RECOVERY_CODES,
  SECOND_STEP_LIMITS,
  STEP_UP_MINUTES,
  TOTP,
  TRUST_TIERS,
  TRUSTED_DEVICE_DAYS,
  type TrustTier,
  WEBMAIL_ATTACHMENTS,
} from "@anhourmail/shared";

import { CopyButton } from "./copy-button";

/**
 * Docs components that render facts from @anhourmail/shared — the single source of truth (CLAUDE.md rule 32). The docs
 * publish the product's own names (`PUBLIC_PLATFORM`, anhourmail.com), never a deployment's `PLATFORM_DOMAIN`.
 * docs/public never hard-codes a hostname, port, price or limit; scripts/check-docs.mjs enforces it.
 */

const VALUES = {
  productDomain: PRODUCT_DOMAIN,
  appHost: HOSTS.app,
  webmailHost: HOSTS.webmail,
  imapHost: HOSTS.imap,
  smtpHost: HOSTS.smtp,
  mxHost: HOSTS.mx[0],
  usernameHint: CLIENT_USERNAME_HINT,
  refundWindowDays: String(BILLING.refundWindowDays),
  mailboxDeleteGraceDays: String(MAILBOX_DELETE_GRACE_DAYS),
  inviteDays: String(INVITE_TTL_DAYS),
  inviteEmailsPerDay: String(INVITE_EMAILS_PER_DAY),
  maxPeople: String(MAX_PEOPLE),
  freeStorage: `${PLANS.free.storageGb} GB`,
  plusStorage: `${PLANS.plus.storageGb} GB`,
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
  stepUpMinutes: String(STEP_UP_MINUTES),
} as const;

export type FactKey = keyof typeof VALUES;

/** Inline fact, e.g. `<Value of="imapHost" />`. Hostnames render in mono. */
export function Value({ of, copy = false }: { of: FactKey; copy?: boolean }) {
  const v = VALUES[of];
  const mono = of.endsWith("Host") || of.endsWith("Url") || of === "productDomain";
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

/** Plans with prices and limits. */
export function PlanTable() {
  const unlimited = (n: number | null) => (n === null ? "Unlimited" : String(n));
  return (
    <div className="not-prose overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-fd-muted-foreground">
            <th className="py-2 pr-4 font-medium">Plan</th>
            <th className="py-2 pr-4 font-medium">Price per year</th>
            <th className="py-2 pr-4 font-medium">Storage</th>
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
                <td className="py-2 pr-4">{p.storageGb} GB</td>
                <td className="py-2 pr-4">{p.customDomains ? "Yes" : "No"}</td>
                <td className="py-2 pr-4">{unlimited(p.aliases)}</td>
                <td className="py-2 pr-4">{unlimited(p.maskedAliases)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
