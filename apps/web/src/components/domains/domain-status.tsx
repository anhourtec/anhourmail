// SPDX-License-Identifier: AGPL-3.0-only
import type { DomainView } from "@anhourmail/core/domains";

import { StatusText, type Tone } from "../console/status-text";

export type DomainState = "active" | "setting_up" | "pending_dns" | "removing";

export const DOMAIN_STATE: Record<DomainState, { text: string; tone: Tone }> = {
  active: { text: "Active", tone: "success" },
  setting_up: { text: "Setting up", tone: "info" },
  pending_dns: { text: "Waiting for DNS", tone: "warning" },
  removing: { text: "Removing", tone: "neutral" },
};

/** Waiting for DNS → setting up (verified, the worker is applying it) → active; or being removed. */
export function domainState(d: Pick<DomainView, "status" | "provisioned">): DomainState {
  if (d.status === "removing") return "removing";
  if (d.status === "pending_dns") return "pending_dns";
  return d.provisioned ? "active" : "setting_up";
}

/** A domain's status: small coloured icon and text. */
export function DomainStatus({ d }: { d: Pick<DomainView, "status" | "provisioned"> }) {
  const s = DOMAIN_STATE[domainState(d)];
  return <StatusText tone={s.tone}>{s.text}</StatusText>;
}
