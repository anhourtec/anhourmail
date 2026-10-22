// SPDX-License-Identifier: AGPL-3.0-only
import { ROLE_LABELS } from "@anhourmail/shared/rbac";

import { AUDIT_ACTIONS, type AuditAction } from "./catalogue";
import type { AuditActorKind } from "./repository";
import type { AuditEntry } from "./types";

/**
 * Human labels for the audit log (console tables and filters). Every area of the catalogue has one (unit-tested), and
 * every action gets a sentence-case label: an explicit one below, or "<area noun> <event>".
 */

export const AREA_LABELS = {
  auth: "Sign-in and security",
  account: "Account and people",
  domain: "Domains",
  mailbox: "Mailboxes",
  alias: "Aliases",
  masked_alias: "Masked aliases",
  catch_all: "Catch-all",
  forwarding: "Forwarding",
  sieve: "Filters",
  vacation: "Auto-replies",
  billing: "Billing",
  trust: "Trust and sending limits",
  abuse: "Abuse reports",
  staff: "Anhourtec staff",
  data: "Export and import",
  platform: "Platform",
  audit: "Audit log",
  shared_mailbox: "Shared mailboxes",
  distribution_list: "Distribution lists",
  delegation: "Delegation",
  folder_share: "Folder sharing",
  send_as: "Send as",
  send_on_behalf: "Send on behalf",
  mail_rule: "Mail rules",
  resource_mailbox: "Resource mailboxes",
  message_trace: "Message trace",
  folder_policy: "Folder policies",
  signature: "Signatures",
  signature_template: "Signature templates",
  disclaimer: "Disclaimer",
  bulk: "Bulk sending",
} as const satisfies Record<string, string>;

export type AuditArea = keyof typeof AREA_LABELS;
export const AUDIT_AREAS = Object.keys(AREA_LABELS) as AuditArea[];
export const isAuditArea = (v: unknown): v is AuditArea =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(AREA_LABELS, v);

/** Singular noun for derived labels ("Mailbox suspended"). */
const NOUN: Partial<Record<AuditArea, string>> = {
  domain: "Domain",
  mailbox: "Mailbox",
  alias: "Alias",
  masked_alias: "Masked alias",
  catch_all: "Catch-all",
  forwarding: "Forwarding",
  sieve: "Filters",
  vacation: "Auto-reply",
  shared_mailbox: "Shared mailbox",
  distribution_list: "Distribution list",
  delegation: "Delegation",
  folder_share: "Folder sharing",
  send_as: "Send as",
  send_on_behalf: "Send on behalf",
  mail_rule: "Mail rule",
  resource_mailbox: "Resource mailbox",
  message_trace: "Message trace",
  folder_policy: "Folder policy",
  signature: "Signature",
  signature_template: "Signature template",
  disclaimer: "Disclaimer",
  bulk: "Bulk",
};

const EXPLICIT: Partial<Record<AuditAction, string>> = {
  "auth.sign_in": "Signed in",
  "auth.sign_in_failed": "Sign-in failed",
  "auth.sign_out": "Signed out",
  "auth.password_changed": "Password changed",
  "auth.password_reset": "Password reset",
  "auth.password_reset_requested": "Password reset requested",
  "auth.two_factor_enabled": "Two-factor sign-in turned on",
  "auth.two_factor_disabled": "Two-factor sign-in turned off",
  "auth.app_password_created": "App password created",
  "auth.app_password_revoked": "App password revoked",
  "auth.session_revoked": "Session signed out",
  "auth.locked_out": "Locked out after failed sign-ins",
  "auth.mail_client_sign_in": "Mail app signed in",
  "auth.mail_client_sign_in_failed": "Mail app sign-in failed",
  "auth.two_factor_reset": "Two-factor sign-in reset",
  "auth.backup_code_used": "Recovery code used",
  "auth.sessions_revoked_all": "Signed out everywhere else",
  "auth.new_device": "New device signed in",
  "auth.passkey_added": "Passkey added",
  "auth.passkey_renamed": "Passkey renamed",
  "auth.passkey_removed": "Passkey removed",
  "auth.recovery_codes_regenerated": "New recovery codes created",
  "auth.identity_confirmed": "Confirmed it's you",
  "account.created": "Account created",
  "account.deleted": "Account deleted",
  "account.updated": "Account settings changed",
  "account.invite_sent": "Invite sent",
  "account.invite_accepted": "Invite accepted",
  "account.invite_resent": "Invite sent again",
  "account.invite_revoked": "Invite revoked",
  "account.member_added": "Person added",
  "account.member_removed": "Person removed",
  "account.role_changed": "Role changed",
  "account.ownership_transferred": "Ownership transferred",
  "account.sign_in_policy_changed": "Sign-in requirement changed",
  "account.sign_in_factor_added": "Person set up their first sign-in factor",
  "mailbox.unsuspended": "Mailbox resumed",
  "billing.plan_changed": "Plan changed",
  "billing.payment_succeeded": "Payment succeeded",
  "billing.payment_failed": "Payment failed",
  "billing.refunded": "Refund issued",
  "billing.suspended": "Suspended for billing",
  "billing.reactivated": "Reactivated after billing",
  "trust.tier_changed": "Trust tier changed",
  "trust.limits_changed": "Sending limits changed",
  "trust.restricted": "Account restricted",
  "trust.suspended": "Account suspended",
  "trust.unsuspended": "Account unsuspended",
  "abuse.report_received": "Abuse report received",
  "abuse.report_resolved": "Abuse report resolved",
  "staff.role_granted": "Staff role granted",
  "staff.role_revoked": "Staff role revoked",
  "staff.act_as_started": "Staff started acting as someone",
  "staff.act_as_ended": "Staff stopped acting as someone",
  "staff.account_viewed": "Staff viewed the account",
  "staff.credentials_reset": "Staff reset sign-in details",
  "data.export_requested": "Export requested",
  "data.export_downloaded": "Export downloaded",
  "data.import_started": "Import started",
  "data.import_finished": "Import finished",
  "data.deletion_requested": "Deletion requested",
  "data.deleted": "Data deleted",
  "platform.settings_changed": "Platform settings changed",
  "platform.secret_changed": "Platform secret changed",
  "platform.stalwart_upgraded": "Mail server upgraded",
  "platform.provisioning_failed": "Mail server change failed",
  "platform.reconciler_drift": "Mail server drift found",
  "platform.mailbox_purged": "Mailbox permanently deleted",
  "platform.audit_chain_broken": "Audit chain break found",
  "audit.exported": "Audit log exported",
  "message_trace.viewed": "Message trace viewed",
  "bulk.addon_enabled": "Bulk sending add-on turned on",
  "bulk.addon_disabled": "Bulk sending add-on turned off",
};

const areaOf = (action: string): string => action.slice(0, action.indexOf("."));

/** "mailbox.deletion_scheduled" → "Mailbox deletion scheduled". Unknown actions are shown as they are. */
export function actionLabel(action: string): string {
  const explicit = (EXPLICIT as Record<string, string | undefined>)[action];
  if (explicit) return explicit;
  const area = areaOf(action);
  const noun = isAuditArea(area) ? NOUN[area] : undefined;
  if (!noun || !(AUDIT_ACTIONS as readonly string[]).includes(action)) return action;
  return `${noun} ${action.slice(area.length + 1).replace(/_/g, " ")}`;
}

export function areaLabel(action: string): string {
  const area = areaOf(action);
  return isAuditArea(area) ? AREA_LABELS[area] : area;
}

const roleLabel = (role: string | null): string | null =>
  role
    ? ((ROLE_LABELS as Record<string, string>)[`platform:${role}`] ??
      (ROLE_LABELS as Record<string, string>)[`account:${role}`] ??
      role)
    : null;

export type ActorDescription = {
  kind: AuditActorKind;
  /** Who, in a few words: an email, "Anhourtec staff", "System". */
  label: string;
  /** Role, the staff member during act-as, or the job name. */
  detail: string | null;
};

/**
 * Who did it (CLAUDE.md rule 49): staff actions on an account — including anything done during an act-as session —
 * are always labelled "Anhourtec staff" with the role and, for act-as, the person they acted as.
 */
export function describeActor(e: Pick<AuditEntry, "actor" | "onBehalfOf">): ActorDescription {
  if (e.onBehalfOf) {
    return {
      kind: "staff",
      label: "Anhourtec staff",
      detail: `${e.onBehalfOf.email} acting as ${e.actor.email ?? "a member"}`,
    };
  }
  switch (e.actor.type) {
    case "staff":
      return {
        kind: "staff",
        label: "Anhourtec staff",
        detail: [roleLabel(e.actor.role), e.actor.email].filter(Boolean).join(" · ") || null,
      };
    case "system":
      return { kind: "system", label: "System", detail: e.actor.email };
    case "anonymous":
      return { kind: "anonymous", label: "Signed-out visitor", detail: null };
    default:
      return { kind: "user", label: e.actor.email ?? "Someone", detail: roleLabel(e.actor.role) };
  }
}

/**
 * The partial IP shown in audit views: the network part only (IPv4 /24 → `203.0.113.x`; IPv6 /48 → `2001:db8:1::/48`).
 * The full address stays in the log for investigations (audit.md "Retention").
 */
export function partialIp(ip: string | null): string | null {
  if (!ip) return null;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1] ?? ""}.${v4[2] ?? ""}.${v4[3] ?? ""}.x`;
  if (ip.includes(":")) {
    const [head = ""] = ip.split("::");
    const groups = head.split(":").filter((g) => g !== "");
    return `${groups.slice(0, 3).join(":") || "0"}::/48`;
  }
  return "hidden";
}
