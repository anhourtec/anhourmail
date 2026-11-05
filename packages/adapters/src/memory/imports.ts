// SPDX-License-Identifier: AGPL-3.0-only
/**
 * In-memory `MailSource` and `MailDestination` (ADR-0030 §9) for the runner's unit tests: a source server and our
 * destination as plain data, behaving like the imapflow adapters (and the pinned mail server) where the runner relies
 * on it — read-only source sessions, CREATE with parents, no de-duplication on APPEND, header-only dedupe index that
 * sees through our marker line, an over-quota answer, and connect failures as codes.
 */
import {
  dedupeKey,
  destinationDedupeKey,
  type DestinationFolder,
  type DestinationSession,
  headerFields,
  ImportConnectError,
  type ImportConnectFailure,
  ImportSessionError,
  type MailDestination,
  type MailSource,
  messageFingerprint,
  normalizeMessageId,
  type SourceFolder,
  type SourceMessageMeta,
  type SourceSession,
} from "@anhourmail/core/imports";

export type FakeMessage = { uid: number; raw: string; flags: string[]; internalDate: Date | null };
export type FakeSourceFolder = {
  path: string;
  delimiter?: string;
  specialUse?: string | null;
  specialUseSource?: "server" | "name" | null;
  selectable?: boolean;
  uidValidity?: bigint;
  messages: FakeMessage[];
};

export type FakeSourceServer = {
  folders: FakeSourceFolder[];
  /** Sign-in: the username and password it accepts. */
  username: string;
  password: string;
  /** Make the next connects fail with this code. */
  failConnect?: ImportConnectFailure | null;
  /** Drop the connection after this many body reads (then reset). */
  dropAfterBodies?: number | null;
  /** Commands seen, for "the source is never changed" assertions. */
  log: string[];
};

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);
const text = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");

function meta(m: FakeMessage): SourceMessageMeta {
  const fields = headerFields(m.raw);
  const size = Buffer.byteLength(m.raw, "latin1");
  return {
    uid: m.uid,
    flags: [...m.flags],
    internalDate: m.internalDate,
    size,
    messageId: normalizeMessageId(fields.get("message-id")),
    fingerprint: messageFingerprint(fields, size),
  };
}

export function fakeSource(server: FakeSourceServer): MailSource {
  let bodies = 0;
  return {
    async connect(endpoint, auth, signal) {
      if (signal.aborted) throw new ImportConnectError("unreachable");
      if (server.failConnect) throw new ImportConnectError(server.failConnect);
      if (auth.username !== server.username || auth.secret !== server.password) throw new ImportConnectError("auth");
      server.log.push(`connect ${endpoint.host}:${String(endpoint.port)}`);
      let open: FakeSourceFolder | null = null;
      const session: SourceSession = {
        async folders(): Promise<SourceFolder[]> {
          return server.folders.map((f) => ({
            path: f.path,
            delimiter: f.delimiter ?? "/",
            specialUse: f.specialUse ?? null,
            specialUseSource: f.specialUse ? (f.specialUseSource ?? "server") : null,
            selectable: f.selectable ?? true,
            uidValidity: f.uidValidity ?? 1n,
            uidNext: (f.messages.at(-1)?.uid ?? 0) + 1,
            messages: f.messages.length,
            sizeBytes: f.messages.reduce((n, m) => n + Buffer.byteLength(m.raw, "latin1"), 0),
          }));
        },
        async open(path) {
          if (signal.aborted) throw new ImportSessionError("dropped");
          const f = server.folders.find((x) => x.path === path);
          if (!f) throw new ImportSessionError("refused");
          server.log.push(`examine ${path}`);
          open = f;
          return { uidValidity: f.uidValidity ?? 1n };
        },
        async headers(afterUid, limit) {
          if (signal.aborted) throw new ImportSessionError("dropped");
          if (!open) throw new ImportSessionError("refused");
          return open.messages
            .filter((m) => m.uid > afterUid)
            .sort((a, b) => a.uid - b.uid)
            .slice(0, limit)
            .map(meta);
        },
        async body(uid, maxBytes) {
          if (signal.aborted) throw new ImportSessionError("dropped");
          if (!open) throw new ImportSessionError("refused");
          if (server.dropAfterBodies != null && bodies >= server.dropAfterBodies) {
            server.dropAfterBodies = null;
            bodies = 0;
            throw new ImportSessionError("dropped");
          }
          const m = open.messages.find((x) => x.uid === uid);
          if (!m) throw new ImportSessionError("refused");
          bodies += 1;
          server.log.push(`peek ${String(uid)}`);
          const b = bytes(m.raw);
          return b.byteLength > maxBytes ? "too_large" : b;
        },
        async close() {
          open = null;
        },
      };
      return session;
    },
  };
}

export type StoredMessage = { raw: string; flags: string[]; internalDate: Date | null };

export type FakeDestinationServer = {
  address: string;
  secret: string;
  folders: Map<string, { specialUse: string | null; messages: StoredMessage[] }>;
  quotaBytes: number | null;
  /** Everything appended, in order (folder and flags), for assertions. */
  appends: { folder: string; flags: string[] }[];
  failConnect?: ImportConnectFailure | null;
  /** Refuse APPENDs larger than this (the server's own limit): `rejected`. */
  rejectOver?: number | null;
};

/** Our mail server's default folders, as a new account has them. */
export function defaultDestinationFolders(): FakeDestinationServer["folders"] {
  return new Map([
    ["INBOX", { specialUse: null, messages: [] }],
    ["Sent Items", { specialUse: "\\Sent", messages: [] }],
    ["Drafts", { specialUse: "\\Drafts", messages: [] }],
    ["Junk Mail", { specialUse: "\\Junk", messages: [] }],
    ["Deleted Items", { specialUse: "\\Trash", messages: [] }],
    ["Archive", { specialUse: "\\Archive", messages: [] }],
  ]);
}

const used = (server: FakeDestinationServer) =>
  [...server.folders.values()].reduce(
    (n, f) => n + f.messages.reduce((m, x) => m + Buffer.byteLength(x.raw, "latin1"), 0),
    0,
  );

export function fakeDestination(server: FakeDestinationServer): MailDestination {
  return {
    async connect(address, secret, signal) {
      if (signal.aborted) throw new ImportConnectError("unreachable");
      if (server.failConnect) throw new ImportConnectError(server.failConnect);
      if (address !== server.address || secret !== server.secret) throw new ImportConnectError("auth");
      const find = (path: string) =>
        [...server.folders.entries()].find(([p]) => p.toLowerCase() === path.toLowerCase())?.[1];
      const session: DestinationSession = {
        async folders(): Promise<DestinationFolder[]> {
          return [...server.folders.entries()].map(([path, f]) => ({ path, specialUse: f.specialUse }));
        },
        async ensureFolder(path) {
          if (signal.aborted) throw new ImportSessionError("dropped");
          const parts = path.split("/");
          for (let i = 1; i <= parts.length; i++) {
            const p = parts.slice(0, i).join("/");
            if (!find(p)) server.folders.set(p, { specialUse: null, messages: [] });
          }
        },
        async index(path) {
          const f = find(path);
          const keys = new Set<string>();
          for (const m of f?.messages ?? []) {
            keys.add(destinationDedupeKey(headerFields(m.raw), Buffer.byteLength(m.raw, "latin1")));
          }
          return keys;
        },
        async append(path, raw, flags, internalDate) {
          if (signal.aborted) throw new ImportSessionError("dropped");
          const f = find(path);
          if (!f) return "rejected";
          if (server.rejectOver != null && raw.byteLength > server.rejectOver) return "rejected";
          if (server.quotaBytes !== null && used(server) + raw.byteLength > server.quotaBytes) return "over_quota";
          f.messages.push({ raw: text(raw), flags: [...flags], internalDate });
          server.appends.push({ folder: path, flags: [...flags] });
          return "ok";
        },
        async quota() {
          return { usedBytes: used(server), limitBytes: server.quotaBytes };
        },
        async close() {
          return;
        },
      };
      return session;
    },
  };
}

/** The dedupe key of a stored raw message (as the source would compute it, for test assertions). */
export const keyOf = (raw: string): string => {
  const fields = headerFields(raw);
  return dedupeKey({
    messageId: normalizeMessageId(fields.get("message-id")),
    fingerprint: messageFingerprint(fields, Buffer.byteLength(raw, "latin1")),
  });
};
