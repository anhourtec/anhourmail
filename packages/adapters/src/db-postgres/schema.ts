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
  trustTier: text("trust_tier").notNull().default("new"),
  updatedAt: updatedAt(),
});

/** A customer account (a person, a family or a small group). */
export const customerAccount = pgTable("customer_account", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  status: text("status").notNull().default("active"),
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
    createdAt: createdAt(),
  },
  (t) => [
    index("mailbox_account_idx").on(t.accountId),
    index("mailbox_purge_idx")
      .on(t.purgeAfter)
      .where(sql`status = 'deleting'`),
  ],
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
