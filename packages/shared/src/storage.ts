// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How the console shows mailbox storage (the mailbox list, the mailbox panel and the home page): sizes in the units
 * plans are sold in, how full a mailbox is, and how long ago it was measured. Pure functions, safe in the browser.
 * The measurement itself is the scheduler's `job:storage-usage` (`@anhourmail/core/mailboxes` `measureStorage`).
 */

/** At or above this share of the quota the console shows the mailbox as getting full (amber). */
export const STORAGE_WARNING_RATIO = 0.8;
/** At or above this share it shows as almost full (red). */
export const STORAGE_CRITICAL_RATIO = 0.95;

const KB = 1024;
const MB = 1024 ** 2;
const GiB = 1024 ** 3;

/** Trims a trailing ".0": 30 GB, 1.2 GB. */
const oneDecimal = (n: number): string => {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

/**
 * A size the way the console shows quotas (binary units, labelled as plans are: 1 GB = 1024³ bytes): "0 B", "512 B",
 * "12 KB", "3.4 MB", "250 MB", "1.2 GB", "30 GB". Negative or non-finite input reads as 0.
 */
export function formatBytes(bytes: number): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (b < KB) return `${String(Math.round(b))} B`;
  if (b < MB) return `${String(Math.max(1, Math.round(b / KB)))} KB`;
  if (b < GiB) {
    const mb = b / MB;
    return mb < 10 ? `${oneDecimal(mb)} MB` : `${String(Math.min(1023, Math.round(mb)))} MB`;
  }
  return `${oneDecimal(b / GiB)} GB`;
}

export type StorageLevel = "unknown" | "ok" | "warning" | "critical" | "full";

export type StorageSummary = {
  level: StorageLevel;
  /** "1.2 GB" (null: never measured). */
  used: string | null;
  /** "30 GB". */
  quota: string;
  /** Share of the quota for the bar, 0–1 (capped at 1). Null: never measured. */
  fraction: number | null;
  /** "12%", "<1%", "100%" (null: never measured). Whole percent, rounded down so 79.6% isn't shown as 80%. */
  percent: string | null;
  /** Words that say what the colour says, for warning and above ("Getting full", "Almost full", "Full"). */
  label: string | null;
};

/** How full a mailbox is, for display. `usedBytes` null = never measured. */
export function storageSummary(usedBytes: number | null, quotaBytes: number): StorageSummary {
  const quota = formatBytes(quotaBytes);
  if (usedBytes === null || !Number.isFinite(usedBytes)) {
    return { level: "unknown", used: null, quota, fraction: null, percent: null, label: null };
  }
  const used = Math.max(0, usedBytes);
  const ratio = quotaBytes > 0 ? used / quotaBytes : used > 0 ? 1 : 0;
  const level: StorageLevel =
    ratio >= 1
      ? "full"
      : ratio >= STORAGE_CRITICAL_RATIO
        ? "critical"
        : ratio >= STORAGE_WARNING_RATIO
          ? "warning"
          : "ok";
  const whole = Math.min(100, Math.floor(ratio * 100));
  return {
    level,
    used: formatBytes(used),
    quota,
    fraction: Math.min(1, ratio),
    percent: used > 0 && whole === 0 ? "<1%" : `${String(whole)}%`,
    label:
      level === "full" ? "Full" : level === "critical" ? "Almost full" : level === "warning" ? "Getting full" : null,
  };
}

/** "Updated just now", "Updated 5 minutes ago", "Updated 3 hours ago", "Updated 2 days ago"; null if never. */
export function storageCheckedAgo(checkedAt: Date | null, now: Date): string | null {
  if (checkedAt === null) return null;
  const minutes = Math.floor(Math.max(0, now.getTime() - checkedAt.getTime()) / 60_000);
  const plural = (n: number, unit: string) => `${String(n)} ${unit}${n === 1 ? "" : "s"} ago`;
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${plural(minutes, "minute")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Updated ${plural(hours, "hour")}`;
  return `Updated ${plural(Math.floor(hours / 24), "day")}`;
}

/** The account's total across the mailboxes measured so far (null used: none measured yet). */
export function accountStorage(mailboxes: readonly { quotaBytes: number; storageUsedBytes: number | null }[]): {
  usedBytes: number | null;
  quotaBytes: number;
  measured: number;
  mailboxes: number;
} {
  const measured = mailboxes.filter((m) => m.storageUsedBytes !== null);
  return {
    usedBytes: measured.length === 0 ? null : measured.reduce((s, m) => s + (m.storageUsedBytes ?? 0), 0),
    quotaBytes: mailboxes.reduce((s, m) => s + m.quotaBytes, 0),
    measured: measured.length,
    mailboxes: mailboxes.length,
  };
}

const POOL_GB = 1024 ** 3;

/** How an account's storage pool is split: what the mailboxes are given, what is left, and what they hold. */
export type StoragePool = {
  /** The account's pool: plan storage plus purchased blocks. */
  poolBytes: number;
  /** Sum of every mailbox's quota (can exceed the pool only for mailboxes kept above it to fit their mail). */
  assignedBytes: number;
  /** Pool not yet given to a mailbox (0 when fully or over-assigned). */
  unassignedBytes: number;
  /** Total held across measured mailboxes (null: none measured yet). */
  usedBytes: number | null;
};

export function storagePool(
  poolBytes: number,
  mailboxes: readonly { quotaBytes: number; storageUsedBytes: number | null }[],
): StoragePool {
  const total = accountStorage(mailboxes);
  return {
    poolBytes,
    assignedBytes: total.quotaBytes,
    unassignedBytes: Math.max(0, poolBytes - total.quotaBytes),
    usedBytes: total.usedBytes,
  };
}

/**
 * A new mailbox's default storage: the unassigned pool split evenly over the mailbox slots the plan still has (whole
 * GB, at least 1 GB while any is left), so adding mailboxes one by one never runs the pool dry. 0 = the pool is fully
 * assigned (a new mailbox is refused).
 */
export function defaultShareBytes(unassignedBytes: number, mailboxCount: number, includedMailboxes: number): number {
  const freeGb = Math.floor(Math.max(0, unassignedBytes) / POOL_GB);
  if (freeGb < 1) return 0;
  const slots = Math.max(1, includedMailboxes - mailboxCount);
  return Math.max(1, Math.floor(freeGb / slots)) * POOL_GB;
}

/** Usage rounded up to the next whole GB (at least 1 GB): the least a mailbox's quota can be without being full. */
export function minQuotaBytes(usedBytes: number | null): number {
  const used = usedBytes !== null && Number.isFinite(usedBytes) ? Math.max(0, usedBytes) : 0;
  return Math.max(1, Math.ceil(used / POOL_GB)) * POOL_GB;
}

/** The pool message the console shows when no storage is left to give a mailbox. */
export function poolFullMessage(poolBytes: number): string {
  return `All ${formatBytes(poolBytes)} of this account's storage is assigned. Lower another mailbox's storage or add more.`;
}

/** How full the account's pool is, by what its mailboxes hold (amber at 80%, red at 95%, like a mailbox). */
export function poolSummary(pool: StoragePool): StorageSummary {
  return storageSummary(pool.usedBytes, pool.poolBytes);
}
