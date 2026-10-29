// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountRole, PlatformRole } from "@anhourmail/shared/rbac";

import type { AuditAction } from "./catalogue";

export type AuditActorType = "user" | "staff" | "system" | "api_token" | "anonymous";
export type AuditResult = "success" | "denied" | "failed";

/** `platform` or `account:<id>`. Each scope has its own hash chain. */
export type AuditScope = "platform" | `account:${string}`;

/** The `on_behalf_of` of an entry written during a staff act-as session. */
export type ActAsAttribution = { userId: string; email: string; accountId: string; sessionId: string };

/** What a service passes in. Snapshots keep entries readable after users or objects are deleted. */
export type AuditEntryInput = {
  scope: AuditScope;
  action: AuditAction;
  actor: {
    type: AuditActorType;
    userId: string | null;
    email: string | null;
    role: PlatformRole | AccountRole | null;
    accountId: string | null;
  };
  /**
   * Set on everything done during a staff act-as session (ADR-0023): the staff member, the customer account they act
   * in and the act-as session id. The actor is then the staff member too (type `staff`).
   */
  onBehalfOf: ActAsAttribution | null;
  target: { type: string; id: string | null; label: string | null };
  result: AuditResult;
  errorCode: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  /** before/after values for changes. Redacted with the shared logging list before storage. */
  meta: Record<string, unknown>;
};

export type AuditEntry = AuditEntryInput & {
  id: string;
  at: string;
  /** Position in the scope's chain, starting at 1. */
  seq: number;
  prevHash: string;
  hash: string;
};
