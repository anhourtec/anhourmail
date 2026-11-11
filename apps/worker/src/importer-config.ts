// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The mail importer's settings (ADR-0030 §1, §4, §6; `08-operations.md` "Mail importer"), checked at start-up. It holds
 * **no Stalwart key** and no Redis or Stalwart HTTP setting in production: it reaches Postgres, the mail server's
 * IMAPS port (`IMPORT_DESTINATION_IMAP`) and public IMAP servers on 993/143 only — the ops compose's network enforces
 * that, and the deploy checks it (the deploy gate). Development-only switches (the source allow-list, the dev
 * certificate, the dev port map) are refused in production. Problems name settings only, never values.
 */
import { devImportSources } from "@anhourmail/core/imports";
import { type DevAllowList, hostName } from "@anhourmail/server/net-guard";
import { IMPORT } from "@anhourmail/shared/import";
import { parsePlatformDomain, platformFacts } from "@anhourmail/shared/platform";
import { credentialEnvProblems } from "@anhourmail/stalwart-client";

export type ImporterConfig = {
  databaseUrl: string;
  destination: { host: string; port: number };
  /** The name the destination's certificate is checked against (the public IMAP host). */
  destinationTlsName: string;
  /** Development only: the dev mail server's self-signed certificate. */
  destinationInsecure: boolean;
  devSources: DevAllowList;
  /** Development only: where an allow-listed source's 993/143 really listen (`IMPORT_DEV_SOURCE_PORTS`). */
  devSourcePorts: ReadonlyMap<number, number>;
  processConcurrency: number;
  globalConcurrency: number;
  sliceMs: number;
  /** Lease length (`IMPORT_LEASE_SECONDS`, default 120): how soon a killed importer's import is picked up again. */
  leaseMs: number;
  maxMessagesPerSecond: number;
  maxBytesPerSecond: number;
  maxMessageBytes: number;
  /** Message caps per mailbox over 30 days by its effective trust tier (`IMPORT_MESSAGE_CAPS`); unlisted: none. */
  messageCaps: ReadonlyMap<string, number>;
  idleMs: number;
  heartbeat: string;
};

const present = (v: string | undefined) => v !== undefined && v.trim() !== "";

function int(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  problems: string[],
  max?: number,
) {
  const raw = env[name];
  if (!present(raw)) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || (max !== undefined && n > max)) {
    problems.push(`${name} must be a whole number from 1${max === undefined ? "" : ` to ${String(max)}`}`);
    return fallback;
  }
  return n;
}

function hostPort(value: string): { host: string; port: number } | null {
  const m = /^(.+):(\d{1,5})$/.exec(value.trim());
  const host = m?.[1] === undefined ? null : hostName(m[1]);
  const port = Number(m?.[2]);
  return host === null || !Number.isInteger(port) || port < 1 || port > 65535 ? null : { host, port };
}

/** `new=<n>,standard=<n>` → tier → cap (0: no importing at all for that tier). */
export function parseMessageCaps(value: string | undefined): Map<string, number> | null {
  const out = new Map<string, number>();
  for (const entry of (value ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "")) {
    const m = /^([a-z]+)=(\d+)$/.exec(entry);
    if (!m?.[1] || m[2] === undefined) return null;
    out.set(m[1], Number(m[2]));
  }
  return out;
}

const TIERS_NEEDING_CAPS = ["new", "standard", "restricted"] as const;

/** Reads and checks the importer's settings; throws naming every problem (settings only). */
export function importerConfig(env: Record<string, string | undefined> = process.env): ImporterConfig {
  const production = env.NODE_ENV === "production";
  const problems: string[] = [];
  // No Stalwart key at all, the dev admin refused in production, the legacy key refused everywhere.
  problems.push(...credentialEnvProblems([], env));
  if (production) {
    for (const k of ["STALWART_URL", "REDIS_URL", "MAILBOX_PASSWORD_GRANT_KEY", "SENDER_DELEGATION_KEY"]) {
      if (present(env[k])) problems.push(`${k} must not be given to the importer (it reaches Postgres and IMAP only)`);
    }
  }
  if (!present(env.DATABASE_URL)) problems.push("DATABASE_URL is not set");

  const destSetting = env.IMPORT_DESTINATION_IMAP;
  if (production && !present(destSetting)) problems.push("IMPORT_DESTINATION_IMAP must be set in production");
  const destination = hostPort(
    present(destSetting) ? (destSetting ?? "") : `127.0.0.1:${env.STALWART_IMAPS_PORT ?? "993"}`,
  );
  if (!destination) problems.push("IMPORT_DESTINATION_IMAP must be host:port");
  const insecureSetting = env.IMPORT_DEV_DESTINATION_INSECURE;
  if (production && present(insecureSetting)) {
    problems.push("IMPORT_DEV_DESTINATION_INSECURE is for development only; unset it in production");
  }
  const destinationInsecure = !production && (present(insecureSetting) ? insecureSetting === "true" : true);

  let devSources: DevAllowList = new Set();
  try {
    devSources = devImportSources({ NODE_ENV: env.NODE_ENV, IMPORT_DEV_ALLOW_SOURCES: env.IMPORT_DEV_ALLOW_SOURCES });
  } catch (err) {
    problems.push(err instanceof Error ? err.message : "IMPORT_DEV_ALLOW_SOURCES is invalid");
  }
  const devSourcePorts = new Map<number, number>();
  if (present(env.IMPORT_DEV_SOURCE_PORTS)) {
    if (production) problems.push("IMPORT_DEV_SOURCE_PORTS is for development only; unset it in production");
    for (const entry of (env.IMPORT_DEV_SOURCE_PORTS ?? "").split(",").map((e) => e.trim())) {
      const m = /^(993|143)=(\d{1,5})$/.exec(entry);
      if (!m) {
        problems.push("IMPORT_DEV_SOURCE_PORTS must be like 993=43993,143=43143");
        break;
      }
      devSourcePorts.set(Number(m[1]), Number(m[2]));
    }
  }

  const caps = parseMessageCaps(env.IMPORT_MESSAGE_CAPS);
  if (caps === null) problems.push("IMPORT_MESSAGE_CAPS must be like new=<n>,standard=<n>,restricted=0");
  if (production && caps !== null) {
    const missing = TIERS_NEEDING_CAPS.filter((t) => !caps.has(t));
    if (missing.length > 0) problems.push(`IMPORT_MESSAGE_CAPS must set ${missing.join(", ")} in production`);
  }

  const out: ImporterConfig = {
    databaseUrl: env.DATABASE_URL ?? "",
    destination: destination ?? { host: "127.0.0.1", port: 993 },
    destinationTlsName: present(env.IMPORT_DESTINATION_TLS_NAME)
      ? (env.IMPORT_DESTINATION_TLS_NAME ?? "")
      : platformFacts(parsePlatformDomain(env.PLATFORM_DOMAIN)).hosts.imap,
    destinationInsecure,
    devSources,
    devSourcePorts,
    processConcurrency: int(env, "IMPORT_PROCESS_CONCURRENCY", 2, problems, 16),
    globalConcurrency: int(env, "IMPORT_GLOBAL_CONCURRENCY", 4, problems, 64),
    sliceMs: int(env, "IMPORT_SLICE_MINUTES", 15, problems, 60) * 60_000,
    leaseMs: int(env, "IMPORT_LEASE_SECONDS", 120, problems, 600) * 1000,
    maxMessagesPerSecond: int(env, "IMPORT_MAX_MESSAGES_PER_SECOND", 20, problems, 1000),
    maxBytesPerSecond: int(env, "IMPORT_MAX_BYTES_PER_SECOND", 10_000_000, problems),
    maxMessageBytes: int(env, "IMPORT_MAX_MESSAGE_BYTES", IMPORT.maxMessageBytes, problems, IMPORT.maxMessageBytes),
    messageCaps: caps ?? new Map(),
    idleMs: int(env, "IMPORT_IDLE_MS", 5000, problems, 600_000),
    heartbeat: env.IMPORTER_HEARTBEAT ?? "/tmp/importer-heartbeat",
  };
  if (production && present(env.IMPORT_MAX_MESSAGE_BYTES)) {
    problems.push("IMPORT_MAX_MESSAGE_BYTES is for tests only; unset it in production");
  }
  if (problems.length > 0) throw new Error(`Importer configuration refused: ${problems.join("; ")}`);
  return out;
}
