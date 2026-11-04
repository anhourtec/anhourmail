// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `ImapSourceReader` (ADR-0030 §3–§5): reads a mailbox at another provider. Read-only by construction: folders are
 * opened with `EXAMINE`, messages read with `BODY.PEEK` (so `\Seen` never changes), and no command that changes
 * anything (STORE, EXPUNGE, COPY, MOVE, DELETE, APPEND) is ever sent. One connection per session, used sequentially.
 */
import type { ImapFlow, ListResponse } from "imapflow";

import {
  headerFields,
  type MailSource,
  messageFingerprint,
  normalizeMessageId,
  type SourceAuth,
  type SourceEndpoint,
  type SourceFolder,
  type SourceMessageMeta,
  type SourceSession,
  SOURCE_HEADER_FIELDS,
} from "@anhourmail/core/imports";
import { IMPORT } from "@anhourmail/shared/import";

import { closeImapClient, type ImapClientOptions, openImapClient, sessionFailure, sourceTarget } from "./connect";

/** A folder's special use and where it came from (`user` hints are ours, never passed, so ignored). */
function specialUseOf(f: ListResponse): Pick<SourceFolder, "specialUse" | "specialUseSource"> {
  if (!f.specialUse) return { specialUse: null, specialUseSource: null };
  if (f.specialUseSource === "extension") return { specialUse: f.specialUse, specialUseSource: "server" };
  if (f.specialUseSource === "name") return { specialUse: f.specialUse, specialUseSource: "name" };
  return { specialUse: null, specialUseSource: null };
}

const selectable = (f: ListResponse) => {
  const flags = [...f.flags].map((x) => x.toLowerCase());
  return !flags.includes("\\noselect") && !flags.includes("\\nonexistent");
};

export function toSourceFolder(f: ListResponse): SourceFolder {
  const status = f.status;
  return {
    path: f.path,
    delimiter: f.delimiter || "/",
    ...specialUseOf(f),
    selectable: selectable(f),
    uidValidity: status?.uidValidity ?? null,
    uidNext: status?.uidNext ?? null,
    messages: status?.messages ?? null,
    sizeBytes: typeof status?.size === "number" ? status.size : null,
  };
}

/** UIDs asked for per `UID SEARCH` (bounds the answer line whatever the folder's size). */
const UID_WINDOW = 5000;

class ImapSourceSession implements SourceSession {
  #uidNext = 0;

  constructor(private readonly client: ImapFlow) {}

  async folders(): Promise<SourceFolder[]> {
    try {
      const size = this.client.capabilities.has("STATUS=SIZE");
      const list = await this.client.list({
        statusQuery: { messages: true, uidValidity: true, uidNext: true, ...(size ? { size: true } : {}) },
      });
      return list.map(toSourceFolder);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  async open(path: string): Promise<{ uidValidity: bigint }> {
    try {
      const box = await this.client.mailboxOpen(path, { readOnly: true });
      this.#uidNext = box.uidNext;
      return { uidValidity: box.uidValidity };
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  async headers(afterUid: number, limit: number): Promise<SourceMessageMeta[]> {
    try {
      // Explicit UID windows up to UIDNEXT (never `n:*`, which answers the last message even below n): each SEARCH
      // answer stays small however large the folder is.
      const chunk: number[] = [];
      for (let from = afterUid + 1; from < this.#uidNext && chunk.length < limit; from += UID_WINDOW) {
        const to = Math.min(from + UID_WINDOW - 1, this.#uidNext - 1);
        const found = await this.client.search({ uid: `${String(from)}:${String(to)}` }, { uid: true });
        const uids = (Array.isArray(found) ? found : []).filter((u) => u >= from && u <= to).sort((a, b) => a - b);
        chunk.push(...uids.slice(0, limit - chunk.length));
      }
      if (chunk.length === 0) return [];
      const out: SourceMessageMeta[] = [];
      for await (const m of this.client.fetch(
        chunk.join(","),
        { uid: true, flags: true, internalDate: true, size: true, headers: [...SOURCE_HEADER_FIELDS] },
        { uid: true },
      )) {
        const fields = headerFields(m.headers ?? new Uint8Array());
        const size = m.size ?? 0;
        const date = m.internalDate === undefined ? null : new Date(m.internalDate);
        out.push({
          uid: m.uid,
          flags: [...(m.flags ?? new Set<string>())],
          internalDate: date !== null && Number.isFinite(date.getTime()) ? date : null,
          size,
          messageId: normalizeMessageId(fields.get("message-id")),
          fingerprint: messageFingerprint(fields, size),
        });
      }
      return out.sort((a, b) => a.uid - b.uid);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  async body(uid: number, maxBytes: number): Promise<Uint8Array | "too_large"> {
    try {
      const meta = await this.client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
      if (!meta) throw new Error("gone");
      if ((meta.size ?? 0) > maxBytes) return "too_large";
      const m = await this.client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!m || !m.source) throw new Error("gone");
      if (m.source.byteLength > maxBytes) return "too_large";
      return new Uint8Array(m.source.buffer, m.source.byteOffset, m.source.byteLength);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  async close(): Promise<void> {
    await closeImapClient(this.client);
  }
}

/**
 * The old provider's IMAP server as a `MailSource`. Only password sign-in today (`SourceAuth` grows an OAuth variant
 * later, ADR-0030 §11). Ports 993 (TLS) and 143 (STARTTLS required).
 */
export function imapMailSource(
  o: Omit<ImapClientOptions, "maxMessageBytes"> & { maxMessageBytes?: number } = {},
): MailSource {
  const options = { maxMessageBytes: IMPORT.maxMessageBytes, ...o };
  return {
    async connect(endpoint: SourceEndpoint, auth: SourceAuth, signal: AbortSignal): Promise<SourceSession> {
      // The guard runs on every connect (each slice, each reconnect): a DNS change since the last one is caught.
      const target = await sourceTarget(endpoint, options, signal);
      const client = await openImapClient(target, { user: auth.username, pass: auth.secret }, options, signal);
      return new ImapSourceSession(client);
    },
  };
}
