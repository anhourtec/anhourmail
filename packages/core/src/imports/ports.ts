// SPDX-License-Identifier: AGPL-3.0-only
import type { ImportSourcePort } from "@anhourmail/shared/import";

/**
 * The importer's ports (ADR-0030 §9). Adapters: `packages/adapters/src/imap` (imapflow, the only IMAP code) and
 * in-memory fakes for tests. Mail passes through these one message at a time, in memory; nothing here is logged.
 */

/** How the source is signed in to. Later: `{ kind: "oauth2"; provider: string; accessToken: string }`. */
export type SourceAuth = { kind: "password"; username: string; secret: string };

export type SourceEndpoint = { host: string; port: ImportSourcePort };

export type SourceFolder = {
  /** The server's path (its own delimiter, decoded from modified UTF-7). Personal: never logged or stored unsealed. */
  path: string;
  delimiter: string;
  /** RFC 6154 attribute (`\Sent`, …) or null. */
  specialUse: string | null;
  /** Where `specialUse` came from: the server's LIST answer, or a match on a localized folder name. */
  specialUseSource: "server" | "name" | null;
  /** False for `\Noselect` / `\NonExistent` folders (hierarchy only, no messages). */
  selectable: boolean;
  uidValidity: bigint | null;
  uidNext: number | null;
  messages: number | null;
  /** STATUS=SIZE when the server offers it, else null (the planner sums `size` instead). */
  sizeBytes: number | null;
};

export type SourceMessageMeta = {
  uid: number;
  /** Keywords and system flags as the server sent them (`\Seen`, `$Forwarded`, …). */
  flags: string[];
  internalDate: Date | null;
  size: number;
  /** The Message-ID without angle brackets or whitespace, or null when it has none. */
  messageId: string | null;
  /** SHA-256 (hex) of the raw `Date`, `From` and `Subject` values and the size: the dedupe key without a Message-ID. */
  fingerprint: string;
};

export type ImportConnectFailure =
  /** The host isn't a public address (or an internal name), the port isn't 993/143, or the name isn't one. */
  | "blocked_address"
  | "bad_host"
  | "bad_port"
  /** Sign-in refused (source: the old provider's password; destination: our credential). */
  | "auth"
  /** No TLS, or the server didn't offer STARTTLS on 143. */
  | "tls_required"
  /** The certificate isn't valid for the host name (self-signed, expired, mismatched). */
  | "certificate"
  /** Resolution, connect, greeting or socket failed or timed out. */
  | "unreachable";

/** A failure the importer maps to a blocked reason or a retry. Carries a code only, never server text. */
export class ImportConnectError extends Error {
  override readonly name = "ImportConnectError";
  constructor(readonly code: ImportConnectFailure) {
    super(`IMAP connect failed: ${code}`);
  }
}

/** A command failed after sign-in (dropped connection, server refusal): retried by the runner. */
export class ImportSessionError extends Error {
  override readonly name = "ImportSessionError";
  constructor(readonly code: "dropped" | "refused" | "timeout") {
    super(`IMAP session failed: ${code}`);
  }
}

export type MailSource = {
  connect(endpoint: SourceEndpoint, auth: SourceAuth, signal: AbortSignal): Promise<SourceSession>;
};

export type SourceSession = {
  /** Every folder with its status (`LIST` + `STATUS`). */
  folders(): Promise<SourceFolder[]>;
  /** Opens `path` read-only (`EXAMINE`); the source is never changed. */
  open(path: string): Promise<{ uidValidity: bigint }>;
  /**
   * Metadata of the open folder's messages with UID > `afterUid`, in UID order, at most `limit`. Messages flagged
   * `\Deleted` are included (the runner skips them).
   */
  headers(afterUid: number, limit: number): Promise<SourceMessageMeta[]>;
  /** One message's raw bytes (`BODY.PEEK[]`), or `too_large` (without reading it) over `maxBytes`. */
  body(uid: number, maxBytes: number): Promise<Uint8Array | "too_large">;
  close(): Promise<void>;
};

export type DestinationFolder = { path: string; specialUse: string | null };

export type AppendResult = "ok" | "over_quota" | "rejected";

export type MailDestination = {
  /** Signs in to our mail server over IMAPS with the import credential. */
  connect(address: string, secret: string, signal: AbortSignal): Promise<DestinationSession>;
};

export type DestinationSession = {
  folders(): Promise<DestinationFolder[]>;
  /** `CREATE` (parents too) and `SUBSCRIBE`; nothing happens when it exists already. Path uses `/`. */
  ensureFolder(path: string): Promise<void>;
  /** The dedupe keys (`dedupeKey`) of every message in the folder; an empty set for an empty or missing folder. */
  index(path: string): Promise<Set<string>>;
  append(path: string, raw: Uint8Array, flags: string[], internalDate: Date | null): Promise<AppendResult>;
  /** The account's storage quota (bytes); `limitBytes` null when the server reports none. */
  quota(): Promise<{ usedBytes: number; limitBytes: number | null }>;
  close(): Promise<void>;
};

/** Web app only (the operations key), under the mailbox's credential lock. */
export type ImportCredentialIssuer = {
  mint(stalwartAccountId: string, expiresAt: Date): Promise<{ id: string; createdAt: Date; secret: string }>;
  /** Clean-up when recording the import fails. */
  destroy(stalwartAccountId: string, id: string): Promise<void>;
};

/**
 * Removes the spam-classifier training samples a mail import created (ADR-0030 update 2026-11-05): on the pinned mail
 * server every APPEND adds one, and the model is shared server-wide. Adapter: the worker's training key, which can only
 * read and destroy samples. Matched by the mail server account, kind (ham only: an import never writes into Junk) and
 * the importer slice's window. Returns how many were destroyed (counts only, never what they were).
 */
export type ImportTrainingSamples = {
  removeImported(stalwartAccountId: string, window: { from: Date; to: Date }): Promise<{ removed: number }>;
};
