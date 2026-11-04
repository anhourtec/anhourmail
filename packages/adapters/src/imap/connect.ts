// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Opening an IMAP connection for the importer (ADR-0030 §3–§4), the one place `imapflow` is configured:
 *
 * - **TLS always:** 993 is implicit TLS, 143 must upgrade with STARTTLS (`doSTARTTLS: true`, no cleartext fallback).
 *   TLS 1.2 or newer, certificates verified (system CAs) against the host name the person typed, sent as SNI.
 * - **Guarded:** the host is checked by `@anhourmail/server/net-guard` on every connect (public addresses only, ports
 *   993/143) and the socket goes to the pinned address, so DNS can't change between the check and the connect.
 * - **Quiet and minimal:** `logger: false` (server text can carry the username), no proxy or custom transport, no
 *   compression, no automatic IDLE (the import credential can't IDLE, and a refused command gets no reply), and a
 *   client ID of `AnhourMail import` only.
 * - **Bounded:** literal and response size caps above the per-message limit, so a hostile server can't make us buffer
 *   more than one message; timeouts on connect, greeting and an idle socket.
 *
 * Errors become `ImportConnectError` / `ImportSessionError` codes; the original error (with server text) is dropped.
 */
import { ImapFlow, type ImapFlowOptions } from "imapflow";

import { ImportConnectError, type ImportConnectFailure, ImportSessionError } from "@anhourmail/core/imports";
import { type DevAllowList, guardTarget, type Resolver } from "@anhourmail/server/net-guard";
import { IMPORT } from "@anhourmail/shared/import";

export type ImapClientOptions = {
  /** Largest message we will read; literal caps sit just above it. */
  maxMessageBytes: number;
  /** Tests only: the resolver the guard uses. */
  resolve?: Resolver;
  /** Development and tests only (`IMPORT_DEV_ALLOW_SOURCES`): exact host:port pairs let through, certificate unchecked. */
  allow?: DevAllowList;
  connectionTimeoutMs?: number;
  greetingTimeoutMs?: number;
  socketTimeoutMs?: number;
  /** Tests only: a stand-in for `ImapFlow` that records its options instead of connecting. */
  clientClass?: typeof ImapFlow;
  /**
   * Tests only: where a checked target's socket really goes (the dev server's published ports). TLS still checks the
   * target's name; production connects to the target itself.
   */
  connectTo?: (target: ImapTarget) => { address: string; port: number };
};

export const CLIENT_INFO = { name: "AnhourMail import" };

/** Node TLS error codes that mean the certificate isn't valid for this host. */
const CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

type ImapErrorShape = Error & {
  code?: unknown;
  authenticationFailed?: unknown;
  tlsFailed?: unknown;
  serverResponseCode?: unknown;
  responseStatus?: unknown;
};

/** A connect-time failure as our code; never the server's text. */
export function connectFailure(err: unknown): ImportConnectFailure {
  const e = (err ?? {}) as ImapErrorShape;
  if (e.authenticationFailed === true) return "auth";
  if (e.tlsFailed === true) return "tls_required";
  const code = typeof e.code === "string" ? e.code : "";
  if (CERTIFICATE_CODES.has(code) || code.startsWith("ERR_TLS_CERT") || code.startsWith("ERR_SSL")) {
    return "certificate";
  }
  return "unreachable";
}

/** A failure after sign-in as our code: a refusal (NO/BAD), a timeout, or a dropped connection. */
export function sessionFailure(err: unknown): ImportSessionError {
  const e = (err ?? {}) as ImapErrorShape;
  if (e.responseStatus === "NO" || e.responseStatus === "BAD") return new ImportSessionError("refused");
  if (e.code === "ETIMEOUT" || e.code === "CONNECT_TIMEOUT") return new ImportSessionError("timeout");
  return new ImportSessionError("dropped");
}

/** Whether a command failure is the server's refusal carrying this response code (`OVERQUOTA`, `NONEXISTENT`, …). */
export const refusedWith = (err: unknown, code: string): boolean =>
  ((err ?? {}) as ImapErrorShape).serverResponseCode === code;

/** Fixed parts of every client: the security-relevant options in one place (tested). */
export function baseOptions(o: ImapClientOptions): Omit<ImapFlowOptions, "host" | "port" | "secure" | "auth"> {
  const literal = o.maxMessageBytes + 1024 * 1024;
  return {
    logger: false,
    emitLogs: false,
    clientInfo: CLIENT_INFO,
    disableAutoIdle: true,
    disableCompression: true,
    qresync: false,
    maxLiteralSize: literal,
    maxResponseSize: literal + 1024 * 1024,
    maxLineLength: 4 * 1024 * 1024,
    connectionTimeout: o.connectionTimeoutMs ?? 30_000,
    greetingTimeout: o.greetingTimeoutMs ?? 15_000,
    socketTimeout: o.socketTimeoutMs ?? 120_000,
  };
}

/** Where a client connects: an address, its port, the TLS name to check, and whether the certificate is checked. */
export type ImapTarget = {
  address: string;
  port: number;
  /** SNI and certificate name; empty for an IP literal (the certificate is then checked against the address). */
  servername: string;
  /** False only for development: an exact allow-list entry or `IMPORT_DEV_DESTINATION_INSECURE`. */
  verifyCertificate: boolean;
  /** 993-style implicit TLS; otherwise STARTTLS is required. */
  implicitTls: boolean;
};

/**
 * A source the person typed, through the net guard: public addresses only (or an exact dev allow-list entry), ports
 * 993/143 only, pinned to the checked address. Run again for every connect. Throws `ImportConnectError`.
 */
export async function sourceTarget(
  endpoint: { host: string; port: number },
  o: Pick<ImapClientOptions, "resolve" | "allow">,
  signal: AbortSignal,
): Promise<ImapTarget> {
  const guarded = await guardTarget(endpoint, {
    ports: IMPORT.sourcePorts,
    signal,
    ...(o.resolve ? { resolve: o.resolve } : {}),
    ...(o.allow ? { allow: o.allow } : {}),
  });
  if (!guarded.ok) {
    throw new ImportConnectError(
      guarded.reason === "bad_host" || guarded.reason === "bad_port" || guarded.reason === "blocked_address"
        ? guarded.reason
        : "unreachable",
    );
  }
  const t = guarded.target;
  return {
    address: t.address,
    port: t.port,
    servername: t.servername,
    verifyCertificate: !t.devAllowed,
    implicitTls: t.port === 993,
  };
}

/** Connects to `target` and signs in. Throws `ImportConnectError` (a code, never the server's text). */
export async function openImapClient(
  target: ImapTarget,
  auth: { user: string; pass: string },
  o: ImapClientOptions,
  signal: AbortSignal,
): Promise<ImapFlow> {
  if (signal.aborted) throw new ImportConnectError("unreachable");
  const socket = o.connectTo ? o.connectTo(target) : { address: target.address, port: target.port };
  const client = new (o.clientClass ?? ImapFlow)({
    ...baseOptions(o),
    host: socket.address,
    port: socket.port,
    secure: target.implicitTls,
    doSTARTTLS: !target.implicitTls,
    ...(target.servername === "" ? {} : { servername: target.servername }),
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: target.verifyCertificate },
    auth: { user: auth.user, pass: auth.pass },
  });
  // An error event without a listener would crash the process; failures surface through the awaited calls.
  client.on("error", () => undefined);
  const abort = () => {
    client.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  client.once("close", () => {
    signal.removeEventListener("abort", abort);
  });
  try {
    await client.connect();
  } catch (err) {
    signal.removeEventListener("abort", abort);
    client.close();
    // Read through a function: `signal.aborted` was false at the top, but an abort can land while connecting.
    throw new ImportConnectError(isAborted(signal) ? "unreachable" : connectFailure(err));
  }
  return client;
}

const isAborted = (signal: AbortSignal): boolean => signal.aborted;

/** Signs out politely, then drops the socket whatever happened. Never throws. */
export async function closeImapClient(client: ImapFlow): Promise<void> {
  try {
    if (client.usable) await client.logout();
  } catch {
    // The connection is going away anyway.
  } finally {
    client.close();
  }
}
