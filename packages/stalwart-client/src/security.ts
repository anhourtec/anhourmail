// SPDX-License-Identifier: MIT
/**
 * The mail server's automatic IP bans (`x:Security`) and allow-list (`x:AllowedIp`), as the deployment wants them
 * (research/stalwart.md "Relay hold" and "Which address a refusal counts against", verified on the pinned v0.16.27):
 *
 * - **A finite abuse ban.** Every refused recipient in an SMTP session (relay refused, unknown address) counts
 *   towards `abuseBanRate` (35 a UTC day by default) per client address and per recipient address; once over, the
 *   client's address is banned from every protocol for `abuseBanPeriod`, which defaults to null: for ever. A refused
 *   recipient of a JMAP submission never counts (its SMTP session is a local one, from 127.0.0.1, which is always
 *   allowed). `applyAbuseBanPeriod` sets a finite period, so a person's phone, an office or a carrier's shared address
 *   banned by a mail app's retries is let back in on its own; the rate is left at Stalwart's default.
 * - **No private ranges on the allow-list.** An allowed address is exempt from every automatic ban. Development
 *   allows Docker's private ranges (its one forwarder carries every client); production never does, or the web
 *   container and anything else on the internal networks would be exempt too. `privateAllowedIps` lists what
 *   overlaps them; `assertNoPrivateAllowedIps` refuses to go on (the deploy's bootstrap).
 *
 * Writes are partial updates of the singleton; callers run `ReloadSettings` afterwards (bans are compiled from it).
 */
import { StalwartError } from "./client";
import type { StalwartManagement } from "./management";

/** The private address ranges (RFC 1918, IPv6 unique-local and link-local) the allow-list must never overlap. */
export const PRIVATE_NETWORKS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "fe80::/10"] as const;

/** The shortest and longest abuse-ban period accepted (one minute; thirty days). */
export const ABUSE_BAN_PERIOD_MIN_MS = 60_000;
export const ABUSE_BAN_PERIOD_MAX_MS = 30 * 86_400_000;

/** The environment variable the deploy's bootstrap and the dev plan read the period from (milliseconds). */
export const ABUSE_BAN_PERIOD_ENV = "STALWART_ABUSE_BAN_PERIOD_MS";

function checkPeriod(ms: number): void {
  if (!Number.isInteger(ms) || ms < ABUSE_BAN_PERIOD_MIN_MS || ms > ABUSE_BAN_PERIOD_MAX_MS) {
    throw new StalwartError(
      `abuse ban period must be a whole number of ms from ${String(ABUSE_BAN_PERIOD_MIN_MS)} to ${String(ABUSE_BAN_PERIOD_MAX_MS)}`,
      "set",
    );
  }
}

/**
 * The abuse-ban period from the environment (`STALWART_ABUSE_BAN_PERIOD_MS`). Production requires it (a missing
 * value would leave bans permanent); elsewhere unset means "leave the server as it is" (null).
 */
export function abuseBanPeriodFromEnv(env: Record<string, string | undefined>): number | null {
  const raw = env[ABUSE_BAN_PERIOD_ENV]?.trim();
  if (raw === undefined || raw === "") {
    if (env.NODE_ENV === "production") throw new Error(`${ABUSE_BAN_PERIOD_ENV} must be set in production`);
    return null;
  }
  const ms = Number(raw);
  checkPeriod(ms);
  return ms;
}

type SecuritySettings = { id: string; abuseBanPeriod?: number | null };

/** The abuse-ban period the server holds: milliseconds, or null for a permanent ban. */
export async function abuseBanPeriod(mgmt: StalwartManagement): Promise<number | null> {
  const [s] = await mgmt.transport.getAll<SecuritySettings>("x:Security", ["abuseBanPeriod"], ["singleton"]);
  if (!s) throw new StalwartError("x:Security singleton not found", "method");
  return typeof s.abuseBanPeriod === "number" ? s.abuseBanPeriod : null;
}

/**
 * Sets `x:Security.abuseBanPeriod` to `periodMs` when it differs (nothing else in the object is touched). Returns
 * true when it wrote (the caller then runs `ReloadSettings`).
 */
export async function applyAbuseBanPeriod(mgmt: StalwartManagement, periodMs: number): Promise<boolean> {
  checkPeriod(periodMs);
  if ((await abuseBanPeriod(mgmt)) === periodMs) return false;
  await mgmt.updateSingleton("x:Security", { abuseBanPeriod: periodMs });
  return true;
}

type Network = { v: 4 | 6; bits: bigint; prefix: number };

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    out = (out << 8n) | BigInt(p);
  }
  return out;
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-f:.]+$/i.test(s) || s.split("::").length > 2) return null;
  const [head = "", tail] = s.split("::");
  const groups = (x: string) => (x === "" ? [] : x.split(":"));
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  // An embedded IPv4 tail (`::ffff:10.0.0.1`) is two groups.
  const last = (tail === undefined ? h : t).at(-1);
  const v4 = last?.includes(".") ? parseV4(last) : null;
  if (last?.includes(".") && v4 === null) return null;
  const list = tail === undefined ? h : t;
  if (v4 !== null) list.splice(-1, 1, (v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16));
  const count = h.length + t.length;
  if (tail === undefined ? count !== 8 : count > 7) return null;
  const all = [...h, ...Array<string>(8 - count).fill("0"), ...t];
  let out = 0n;
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out = (out << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return out;
}

/** An address or `address/prefix` as Stalwart stores it; null when it isn't one. */
export function parseNetwork(text: string): Network | null {
  const [addr = "", len, extra] = text.trim().split("/");
  if (extra !== undefined) return null;
  const v: 4 | 6 = addr.includes(":") ? 6 : 4;
  const bits = v === 4 ? parseV4(addr) : parseV6(addr);
  if (bits === null) return null;
  const max = v === 4 ? 32 : 128;
  const prefix = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : -1;
  if (prefix < 0 || prefix > max) return null;
  return { v, bits, prefix };
}

const maskOf = (v: 4 | 6, prefix: number): bigint => {
  const width = BigInt(v === 4 ? 32 : 128);
  return prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << (width - BigInt(prefix));
};

/** Whether two networks share any address. */
function overlaps(a: Network, b: Network): boolean {
  if (a.v !== b.v) return false;
  const mask = maskOf(a.v, Math.min(a.prefix, b.prefix));
  return (a.bits & mask) === (b.bits & mask);
}

const PRIVATE = PRIVATE_NETWORKS.map((n) => parseNetwork(n)).filter((n): n is Network => n !== null);

/**
 * Whether an allow-list entry reaches into a private range (inside one, equal to one, or containing one; an IPv4
 * address written as IPv6, `::ffff:10.0.0.1`, counts). An entry that can't be read counts too: it can't be shown safe.
 */
export function overlapsPrivateNetwork(entry: string): boolean {
  const n = parseNetwork(entry);
  if (n === null) return true;
  const mapped =
    n.v === 6 && n.prefix >= 96 && n.bits >> 32n === 0xffffn
      ? { v: 4 as const, bits: n.bits & 0xffffffffn, prefix: n.prefix - 96 }
      : null;
  return PRIVATE.some((p) => overlaps(n, p) || (mapped !== null && overlaps(mapped, p)));
}

/** The `x:AllowedIp` entries that overlap a private range (expired ones included: an expiry can be changed back). */
export async function privateAllowedIps(mgmt: StalwartManagement): Promise<string[]> {
  const all = await mgmt.transport.getAll<{ id: string; address?: string }>("x:AllowedIp", ["address"]);
  return all.map((a) => a.address ?? "").filter((a) => overlapsPrivateNetwork(a));
}

/** Throws when the allow-list overlaps a private range (the deploy's bootstrap, production). */
export async function assertNoPrivateAllowedIps(mgmt: StalwartManagement): Promise<void> {
  const found = await privateAllowedIps(mgmt);
  if (found.length > 0) {
    throw new Error(
      `the mail server's allow-list exempts private addresses from automatic bans (${String(found.length)} entries); remove them`,
    );
  }
}
