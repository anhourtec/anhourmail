// SPDX-License-Identifier: AGPL-3.0-only
import type { Tone } from "../console/status-text";

/** A billing state as people read it (Billing page, banners, Platform). A plain module: server components import it. */
export const BILLING_STATE_LABELS: Record<
  "free" | "active" | "past_due" | "restricted" | "lapsed",
  { text: string; tone: Tone }
> = {
  free: { text: "Free", tone: "neutral" },
  active: { text: "Active", tone: "success" },
  past_due: { text: "Payment failed, retrying", tone: "warning" },
  restricted: { text: "Sending paused", tone: "danger" },
  lapsed: { text: "Paid plan ended", tone: "warning" },
};

export const PLAN_SOURCE_LABELS: Record<"none" | "stripe" | "comp" | "staff", string> = {
  none: "No paid plan",
  stripe: "Paid subscription",
  comp: "Complimentary (invite code)",
  staff: "Granted by Anhourtec",
};

export const billingDate = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });

/** Bytes as whole or one-decimal gigabytes ("10 GB", "2.5 GB"). */
export function gigabytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${Number.isInteger(gb) ? String(gb) : gb.toFixed(1)} GB`;
}
