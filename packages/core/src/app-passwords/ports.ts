// SPDX-License-Identifier: AGPL-3.0-only
import type { AppPasswordProtocol } from "@anhourmail/shared/security";

/**
 * Issues app passwords on the mail server (adapter: Stalwart, the web app's operations key). `create` runs inside the
 * request because the secret must reach the person and nowhere else — a queued job would have to hold it. Revocation
 * goes through the provisioning queue (`MailServer.revokeAppPassword`); `revoke` here only undoes a create whose
 * record failed to save.
 */
export type AppPasswordIssuer = {
  create(input: {
    /** The mailbox's id on the mail server. */
    externalId: string;
    name: string;
    protocols: readonly AppPasswordProtocol[];
  }): Promise<{ credentialId: string; createdAt: Date; secret: string }>;
  revoke(input: { externalId: string; credentialId: string; createdAt: Date }): Promise<void>;
};

/** What the mail server holds for a mailbox (adapter: Stalwart, the provisioning key — no access to its mail). */
export type AppPasswordInventory = {
  /**
   * What the mail server holds for a mailbox, for the reconciler: its app passwords with the scopes their permissions
   * stand for (null: not a value we make), how many API keys it has (end users never get one), and how many sign-in
   * Password credentials it has (a mailbox has exactly one; more means one was added by hand).
   */
  list(externalId: string): Promise<{
    appPasswords: { credentialId: string; createdAt: Date; protocols: AppPasswordProtocol[] | null }[];
    apiKeys: number;
    passwords: number;
    /** The Password credentials' ids (a mailbox has exactly one; compared with the one the control plane set). */
    passwordIds: string[];
  }>;
};
