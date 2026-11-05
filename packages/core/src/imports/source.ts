// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from "node:net";

import {
  type DevAllowList,
  hostName,
  isInternalName,
  isPublicAddress,
  parseDevAllowList,
} from "@anhourmail/server/net-guard";
import { IMPORT, type ImportSourcePort, isImportSourcePort } from "@anhourmail/shared/import";

import { ValidationError } from "../errors";

/** The source an import reads from, as the person typed it, checked (ADR-0030 §4). */
export type ImportSourceInput = { host: string; port: ImportSourcePort; username: string; secret: string };

export const MAX_SOURCE_USERNAME = 320;
export const MAX_SOURCE_SECRET = 1024;

/**
 * Development's default source allow-list when `IMPORT_DEV_ALLOW_SOURCES` is unset: the dev mail server as the host
 * reaches it (its IMAP ports are published on 993/143) and as the compose importer reaches it (`import-edge`).
 */
export const DEV_IMPORT_SOURCES =
  "127.0.0.1:993,127.0.0.1:143,localhost:993,localhost:143,import-edge:993,import-edge:143";

/**
 * The sources development may import from though they aren't public (`IMPORT_DEV_ALLOW_SOURCES`, or
 * `DEV_IMPORT_SOURCES` when unset). Production: always empty, and setting it at all refuses to start.
 */
export function devImportSources(env: {
  NODE_ENV?: string | undefined;
  IMPORT_DEV_ALLOW_SOURCES?: string | undefined;
}): DevAllowList {
  const value = env.IMPORT_DEV_ALLOW_SOURCES;
  if (env.NODE_ENV === "production") return parseDevAllowList(value, env, "IMPORT_DEV_ALLOW_SOURCES");
  return parseDevAllowList(value ?? DEV_IMPORT_SOURCES, env, "IMPORT_DEV_ALLOW_SOURCES");
}

const devPair = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${String(port)}`;

/**
 * Checks what a person typed for the old provider, before anything is minted or stored: a host name (≤ 253
 * characters, IDN as punycode, no userinfo, path or port) that isn't internal-only (`localhost`, `.local`,
 * `.internal`, `home.arpa`, no dot) and, for an IP literal, a public address; port 993 or 143; a sign-in name and an
 * app password without control characters. The importer checks the host again (it resolves to public addresses only)
 * on every connect. `devAllow` (`IMPORT_DEV_ALLOW_SOURCES`, refused in production) lets exact `host:port` pairs through;
 * with `allowListOnly` (every environment but production) nothing else is accepted.
 * Throws `ValidationError` naming the field, never echoing the value.
 */
export function importSource(
  input: { host?: unknown; port?: unknown; username?: unknown; password?: unknown },
  devAllow: DevAllowList = new Set(),
  opts: { allowListOnly?: boolean } = {},
): ImportSourceInput {
  const port = input.port ?? IMPORT.defaultSourcePort;
  if (!isImportSourcePort(port)) throw new ValidationError("The IMAP port must be 993 (TLS) or 143 (STARTTLS).");
  const host = typeof input.host === "string" ? hostName(input.host) : null;
  if (host === null) throw new ValidationError("Enter the IMAP server's host name, like imap.example.com.");
  if (opts.allowListOnly === true && !devAllow.has(devPair(host, port))) {
    // Development and tests never reach a real provider (rule 19's spirit): only the dev mail server.
    throw new ValidationError("Outside production, imports can only read from the development mail server.");
  }
  if (!devAllow.has(devPair(host, port))) {
    if (isIP(host) !== 0 ? !isPublicAddress(host) : isInternalName(host)) {
      throw new ValidationError("That IMAP server isn't reachable from the internet. Enter its public host name.");
    }
  }
  const username = typeof input.username === "string" ? input.username.trim() : "";
  if (username === "" || username.length > MAX_SOURCE_USERNAME || /\p{Cc}/u.test(username)) {
    throw new ValidationError("Enter the user name you sign in to the old mailbox with.");
  }
  return { host, port, username, secret: importSourceSecret(input.password) };
}

/** The old mailbox's app password as typed (ends trimmed), or `ValidationError`. */
export function importSourceSecret(value: unknown): string {
  const secret = typeof value === "string" ? value.trim() : "";
  if (secret === "" || secret.length > MAX_SOURCE_SECRET || /\p{Cc}/u.test(secret)) {
    throw new ValidationError("Enter an app password for the old mailbox.");
  }
  return secret;
}
