// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `ImapDestinationWriter` (ADR-0030 §1, §5): writes into one of our mailboxes over IMAPS with the import credential.
 * It sends only what that credential allows (`IMPORT_CREDENTIAL_ALLOW` in `@anhourmail/stalwart-client`): LIST,
 * STATUS, CREATE, SUBSCRIBE, APPEND, EXAMINE and FETCH of header fields. Anything else gets no reply from the pinned
 * server, so nothing else is ever sent (no STORE, EXPUNGE, CLOSE, IDLE, …).
 */
import type { ImapFlow, NamespaceObject } from "imapflow";

import {
  type AppendResult,
  DEDUPE_HEADER_FIELDS,
  destinationDedupeKey,
  type DestinationFolder,
  type DestinationSession,
  headerFields,
  ImportSessionError,
  type MailDestination,
} from "@anhourmail/core/imports";
import { IMPORT, IMPORT_DELIMITER } from "@anhourmail/shared/import";

import {
  closeImapClient,
  type ImapClientOptions,
  type ImapTarget,
  openImapClient,
  refusedWith,
  sessionFailure,
} from "./connect";

/** The pinned server's shared-folders namespace (other accounts' folders shared with this one). */
export const SHARED_FOLDERS_PREFIX = "Shared Folders";

/**
 * A destination folder path as the runner built it: `/`-separated, each level 1–255 characters without control
 * characters, and never under a namespace other than the personal one (`Shared Folders`, or any other/shared prefix
 * the server announces; compared ignoring case), so an import only ever writes into the mailbox's own folders — the
 * same rule as the webmail's mail rules (`ownFolderPath`). Anything else is refused before a command is sent.
 */
export function destinationPath(path: string, foreignPrefixes: readonly string[] = [SHARED_FOLDERS_PREFIX]): string[] {
  const parts = path.split(IMPORT_DELIMITER);
  if (parts.length === 0 || parts.length > 32 || parts.some((p) => p === "" || p.length > 255 || /\p{Cc}/u.test(p))) {
    throw new ImportSessionError("refused");
  }
  const lower = path.toLowerCase();
  for (const prefix of foreignPrefixes) {
    const p = prefix.replace(/[/.]+$/, "").toLowerCase();
    if (p !== "" && (lower === p || lower.startsWith(`${p}${IMPORT_DELIMITER}`)))
      throw new ImportSessionError("refused");
  }
  return parts;
}

/** The namespaces the server reports for other users and shared folders, plus ours by name. */
export function foreignNamespaces(client: Pick<ImapFlow, "namespaces">): string[] {
  const ns = client.namespaces;
  const list = (v: NamespaceObject[] | false | undefined) => (Array.isArray(v) ? v : []);
  const listed = [...list(ns?.other), ...list(ns?.shared)].map((n) => n.prefix);
  return [SHARED_FOLDERS_PREFIX, ...listed];
}

type Refusal = Error & { responseStatus?: unknown };
const isRefusal = (err: unknown) => {
  const s = ((err ?? {}) as Refusal).responseStatus;
  return s === "NO" || s === "BAD";
};

class ImapDestinationSession implements DestinationSession {
  #known: Set<string> | null = null;

  readonly #foreign: string[];

  constructor(private readonly client: ImapFlow) {
    this.#foreign = foreignNamespaces(client);
  }

  async folders(): Promise<DestinationFolder[]> {
    try {
      const list = await this.client.list();
      this.#known = new Set(list.map((f) => f.path));
      return list.map((f) => ({ path: f.path, specialUse: f.specialUse ?? null }));
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  async ensureFolder(path: string): Promise<void> {
    const known = this.#known ?? new Set((await this.folders()).map((f) => f.path));
    if (known.has(path)) return;
    const parts = destinationPath(path, this.#foreign);
    try {
      // CREATE makes missing parents too (verified on the pinned server); ALREADYEXISTS is not an error here.
      await this.client.mailboxCreate(parts);
      await this.client.mailboxSubscribe(parts);
    } catch (err) {
      throw sessionFailure(err);
    }
    for (let i = 1; i <= parts.length; i++) known.add(parts.slice(0, i).join(IMPORT_DELIMITER));
  }

  async index(path: string): Promise<Set<string>> {
    const keys = new Set<string>();
    const parts = destinationPath(path, this.#foreign);
    try {
      const box = await this.client.mailboxOpen(parts, { readOnly: true });
      if (box.exists === 0) return keys;
      for await (const m of this.client.fetch(
        "1:*",
        { uid: true, size: true, headers: [...DEDUPE_HEADER_FIELDS] },
        { uid: true },
      )) {
        keys.add(destinationDedupeKey(headerFields(m.headers ?? new Uint8Array()), m.size ?? 0));
      }
      return keys;
    } catch (err) {
      // A folder that isn't there yet holds nothing.
      if (refusedWith(err, "NONEXISTENT") || (isRefusal(err) && this.#known !== null && !this.#known.has(path))) {
        return keys;
      }
      throw sessionFailure(err);
    }
  }

  async append(path: string, raw: Uint8Array, flags: string[], internalDate: Date | null): Promise<AppendResult> {
    const parts = destinationPath(path, this.#foreign);
    try {
      const res = await this.client.append(parts, raw, flags, internalDate ?? undefined);
      if (res === false) throw new Error("not appended");
      return "ok";
    } catch (err) {
      if (refusedWith(err, "OVERQUOTA") || refusedWith(err, "LIMIT")) return "over_quota";
      if (isRefusal(err) || refusedWith(err, "APPENDLIMIT")) return "rejected";
      throw sessionFailure(err);
    }
  }

  async quota(): Promise<{ usedBytes: number; limitBytes: number | null }> {
    try {
      const q = await this.client.getQuota("INBOX");
      const storage = q === false ? undefined : q.storage;
      return { usedBytes: storage?.usage ?? 0, limitBytes: storage?.limit ?? null };
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  async close(): Promise<void> {
    await closeImapClient(this.client);
  }
}

/**
 * Our mail server's IMAPS port as a `MailDestination`. `endpoint` is the importer's `IMPORT_DESTINATION_IMAP` (an
 * internal address: our own server, so not through the public-address guard); TLS is verified against `servername`,
 * the public IMAP host name. `insecureDevCertificate` (`IMPORT_DEV_DESTINATION_INSECURE`, the dev server's
 * self-signed certificate) is refused in production.
 */
export function imapMailDestination(
  o: {
    endpoint: { host: string; port: number };
    servername: string;
    insecureDevCertificate?: boolean;
    env?: { NODE_ENV?: string | undefined };
  } & Omit<ImapClientOptions, "maxMessageBytes" | "resolve" | "allow"> & { maxMessageBytes?: number },
): MailDestination {
  if (o.insecureDevCertificate === true && (o.env ?? process.env).NODE_ENV === "production") {
    throw new Error("IMPORT_DEV_DESTINATION_INSECURE is for development only; unset it in production");
  }
  const options = { maxMessageBytes: IMPORT.maxMessageBytes, ...o };
  const target: ImapTarget = {
    address: o.endpoint.host,
    port: o.endpoint.port,
    servername: o.servername,
    verifyCertificate: o.insecureDevCertificate !== true,
    implicitTls: true,
  };
  return {
    async connect(address: string, secret: string, signal: AbortSignal): Promise<DestinationSession> {
      const client = await openImapClient(target, { user: address, pass: secret }, options, signal);
      return new ImapDestinationSession(client);
    },
  };
}
