// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Control-plane schema (Postgres). Never mail content (CLAUDE.md rule 24). Only this adapter knows table
 * shapes; services see domain types through repository ports (ADR-0008). Entities: docs/internal/04-data-model.md.
 * Every migration is logged in docs/internal/migration.md (rule 15).
 */
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// --- console identity (better-auth core tables; mailbox identity lives in Stalwart) ----------------------

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  /** Display name (shown in the console and as the default sender name). */
  name: text("name").notNull(),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name"),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /** better-auth two-factor plugin: set once an authenticator app is verified. */
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** How this session was signed in (shared/security.ts SIGN_IN_METHODS); account requirements depend on it. */
    signInMethod: text("sign_in_method"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_session_user_idx").on(t.userId)],
);

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_account_user_idx").on(t.userId)],
);

export const authVerification = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * better-auth two-factor plugin (one row per person). `secret` is the plugin's encrypted TOTP secret, sealed again
 * with the key ring (AAD = user id; `packages/adapters/src/auth/sealed-adapter.ts`). `backup_codes` is a JSON array of
 * SHA-256 hashes of the unused recovery codes, never the codes (`auth/recovery-codes.ts`).
 */
export const authTwoFactor = pgTable(
  "auth_two_factor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("auth_two_factor_user_idx").on(t.userId)],
);

/** better-auth passkey plugin: WebAuthn credentials (public keys only; the private key never leaves the device). */
export const authPasskey = pgTable(
  "auth_passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: bigint("counter", { mode: "number" }).notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    aaguid: text("aaguid"),
  },
  (t) => [index("auth_passkey_user_idx").on(t.userId), uniqueIndex("auth_passkey_credential_idx").on(t.credentialID)],
);

// --- roles, accounts, people ------------------------------------------------------------------------------

/** Staff roles (packages/shared/src/rbac PLATFORM_ROLES). */
export const platformRoleAssignment = pgTable(
  "platform_role_assignment",
  {
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    grantedBy: text("granted_by"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);

/** Per-person state that is not a role: free / paid / invited / suspended (rbac USER_STATES). */
export const userProfile = pgTable("user_profile", {
  userId: text("user_id")
    .primaryKey()
    .references(() => authUser.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("free"),
  suspended: boolean("suspended").notNull().default(false),
  /** Staff suspension of the console sign-in (`platform.account.suspend`): reason category, staff-only note, when, who. */
  suspensionReason: text("suspension_reason"),
  suspensionNote: text("suspension_note"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedBy: text("suspended_by"),
  trustTier: text("trust_tier").notNull().default("new"),
  updatedAt: updatedAt(),
});

/** A customer account (a person, a family or a small group). */
export const customerAccount = pgTable("customer_account", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  status: text("status").notNull().default("active"),
  /**
   * Staff suspension (`platform.account.suspend`; status `suspended` while set): reason category, staff-only note
   * (never shown to the customer), when and by whom.
   */
  suspensionReason: text("suspension_reason"),
  suspensionNote: text("suspension_note"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedBy: text("suspended_by"),
  /** What everyone in the account must use to sign in: none | two_factor | passkey (shared/security.ts). */
  signInPolicy: text("sign_in_policy").notNull().default("none"),
  createdAt: createdAt(),
});

export const accountMembership = pgTable(
  "account_membership",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => customerAccount.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.userId] }), index("account_membership_user_idx").on(t.userId)],
);

export const invite = pgTable(
  "invite",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    accountId: uuid("account_id").references(() => customerAccount.id, { onDelete: "cascade" }),
    role: text("role"),
    /** sha256 of the invite token; the token itself is only in the invite link. */
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by"),
    acceptedUserId: text("accepted_user_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invite_email_idx").on(t.email)],
);

/**
 * One row per invite email sent (first send and every resend): the per-account daily cap counts these, not live
 * invites, so invite → revoke loops can't send unlimited mail. No email address or token is stored here.
 */
export const inviteSend = pgTable(
  "invite_send",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => customerAccount.id, { onDelete: "cascade" }),
    inviteId: uuid("invite_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("invite_send_account_at_idx").on(t.accountId, t.sentAt)],
);

// --- mail configuration (desired state; the worker applies it to Stalwart) --------------------------------

export const customerDomain = pgTable(
  "customer_domain",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => customerAccount.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** pending_dns | active | removing */
    status: text("status").notNull().default("pending_dns"),
    verifyToken: text("verify_token").notNull(),
    /** Stalwart's id once provisioned; null until the provisioning job succeeds. */
    stalwartId: text("stalwart_id"),
    lastError: text("last_error"),
    /**
     * Catch-all (paid plans): the account's mailbox that receives mail for unknown addresses at the domain; null =
     * off (unknown recipients refused). Cleared when that mailbox is suspended or deleted.
     */
    catchAllMailboxId: uuid("catch_all_mailbox_id").references(() => mailbox.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("customer_domain_account_idx").on(t.accountId),
    uniqueIndex("customer_domain_account_name_idx").on(t.accountId, t.name),
    // Only a verified claim is exclusive: unverified adds can't squat a domain (ownership TXT decides).
    uniqueIndex("customer_domain_claimed_name_idx")
      .on(t.name)
      .where(sql`status <> 'pending_dns'`),
  ],
);

export const mailbox = pgTable(
  "mailbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => customerAccount.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => authUser.id, { onDelete: "set null" }),
    address: text("address").notNull().unique(),
    stalwartId: text("stalwart_id"),
    /**
     * provisioning | active | failed | suspended | deleting. Suspend, resume, delete and restore set it from the
     * console; the provisioning job moves provisioning → active / failed (CLAUDE.md rule 26).
     */
    status: text("status").notNull().default("active"),
    lastError: text("last_error"),
    quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull(),
    /** Set while `deleting`: the scheduled purge removes the mailbox after this (grace period). */
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    /**
     * A new mailbox password waiting for the worker: a salted argon2id PHC string, never the password (rule 23). Set
     * at creation and by a reset or change; cleared once the mail server has it, or when its job gives up.
     */
    pendingPasswordHash: text("pending_password_hash"),
    /** The web app's HMAC grant for replacing the password with exactly that hash (verified by the management proxy). */
    pendingPasswordGrant: text("pending_password_grant"),
    /** The mail server's id for the mailbox's Password credential as we last set it (reconciler; 07-security.md). */
    passwordCredentialId: text("password_credential_id"),
    /**
     * Storage used at the last measurement (`job:storage-usage`, from the mail server's `usedDiskQuota`): a size only,
     * never anything about the mail (rule 24). Null until measured; a failed measurement keeps the last good value.
     */
    storageUsedBytes: bigint("storage_used_bytes", { mode: "number" }),
    /** When `storage_used_bytes` was measured. */
    storageCheckedAt: timestamp("storage_checked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("mailbox_account_idx").on(t.accountId),
    index("mailbox_purge_idx")
      .on(t.purgeAfter)
      .where(sql`status = 'deleting'`),
  ],
);

/**
 * Mailboxes a staff suspension suspended (kind `account` or `person`): lifting resumes exactly these, and only once no
 * hold is left. A mailbox the account suspended itself never gets one.
 */
export const mailboxStaffHold = pgTable(
  "mailbox_staff_hold",
  {
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.mailboxId, t.kind] })],
);

export const mailAlias = pgTable(
  "mail_alias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => customerAccount.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    address: text("address").notNull().unique(),
    /** `alias` (chosen) or `masked` (random, per-site); both are Stalwart account aliases (ADR-0009). */
    kind: text("kind").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    description: text("description"),
    createdAt: createdAt(),
  },
  (t) => [index("mail_alias_mailbox_idx").on(t.mailboxId)],
);

/**
 * Platform-domain addresses that were in use and are gone (a purged mailbox, a deleted masked alias on the platform
 * domain): never handed to a different account (ADR-0021). No foreign key on purpose: deleting the account must not
 * free its addresses. Never deleted.
 */
export const retiredPlatformAddress = pgTable("retired_platform_address", {
  /** Lowercase full address. */
  address: text("address").primaryKey(),
  /** The account that held it (kept after the account is gone). */
  accountId: uuid("account_id").notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }).notNull(),
});

// --- audit (append-only, hash-chained per scope; ADR-0010) -------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey(),
    scope: text("scope").notNull(),
    seq: integer("seq").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    action: text("action").notNull(),
    actorType: text("actor_type").notNull(),
    actorUserId: text("actor_user_id"),
    actorEmail: text("actor_email"),
    actorRole: text("actor_role"),
    actorAccountId: text("actor_account_id"),
    onBehalfOf: jsonb("on_behalf_of"),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    targetLabel: text("target_label"),
    result: text("result").notNull(),
    errorCode: text("error_code"),
    requestId: text("request_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    meta: jsonb("meta").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    uniqueIndex("audit_log_scope_seq_idx").on(t.scope, t.seq),
    index("audit_log_scope_at_idx").on(t.scope, t.at),
    index("audit_log_actor_idx").on(t.actorUserId),
  ],
);

// --- provisioning queue (desired state → Stalwart; CLAUDE.md rule 26) ---------------------------------------

export const provisioningJob = pgTable(
  "provisioning_job",
  {
    id: uuid("id").primaryKey(),
    /** domain.ensure | mailbox.ensure | aliases.sync */
    kind: text("kind").notNull(),
    /** The control-plane row the job applies (domain or mailbox id). */
    subjectId: text("subject_id").notNull(),
    /** queued | running | succeeded | failed (failed = gave up after max attempts) */
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("provisioning_job_ready_idx").on(t.status, t.runAfter),
    index("provisioning_job_subject_idx").on(t.kind, t.subjectId),
  ],
);

// --- webmail settings (docs/internal/05-webmail.md "Settings") ----------------------------------------------

/**
 * Display preferences per mailbox (layout, density, formats). Never mail content and no addresses: the values are
 * the closed choices in `@anhourmail/shared/webmail`, normalised on read.
 */
export const webmailPreference = pgTable("webmail_preference", {
  mailboxId: uuid("mailbox_id")
    .primaryKey()
    .references(() => mailbox.id, { onDelete: "cascade" }),
  prefs: jsonb("prefs").notNull(),
  updatedAt: updatedAt(),
});

/**
 * A mailbox's one forwarding target and its confirmation (the target's owner must confirm before forwarding can be
 * turned on). The token is stored as its sha256 only. Forwarding itself is a rule in the mail server.
 */
export const forwardingTarget = pgTable(
  "forwarding_target",
  {
    mailboxId: uuid("mailbox_id")
      .primaryKey()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => customerAccount.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    /** pending | confirmed */
    status: text("status").notNull(),
    tokenHash: text("token_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    sendsInWindow: integer("sends_in_window").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("forwarding_target_token_idx").on(t.tokenHash)],
);

// --- app passwords (docs/internal/07-security.md "App passwords") --------------------------------------------

/**
 * App passwords for mail apps: metadata only. The secret is generated and stored (hashed) by Stalwart and shown to
 * the person once; it never reaches this table, a log or the audit log (CLAUDE.md rules 23, 48).
 */
export const appPassword = pgTable(
  "app_password",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => customerAccount.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** imap | pop3 | smtp | dav (shared/security.ts APP_PASSWORD_PROTOCOLS) */
    protocols: text("protocols").array().notNull(),
    /** Stalwart's credential id; reused after a revocation, so matched together with its creation time. */
    credentialId: text("credential_id").notNull(),
    credentialCreatedAt: timestamp("credential_created_at", { withTimezone: true }).notNull(),
    /** active | revoking */
    status: text("status").notNull().default("active"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("app_password_mailbox_idx").on(t.mailboxId)],
);
