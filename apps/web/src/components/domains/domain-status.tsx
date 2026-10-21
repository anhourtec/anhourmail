// SPDX-License-Identifier: AGPL-3.0-only
import type { DomainView } from "@anhourmail/core/domains";

/** Status badge for a domain: waiting for DNS → setting up (verified, worker applying) → active. */
export function DomainStatus({ d }: { d: Pick<DomainView, "status" | "provisioned"> }) {
  if (d.status === "removing") return <span className="am-status am-status--neutral">Removing</span>;
  if (d.status === "pending_dns") return <span className="am-status am-status--warning">Waiting for DNS</span>;
  return d.provisioned ? (
    <span className="am-status am-status--success">Active</span>
  ) : (
    <span className="am-status am-status--info">Setting up</span>
  );
}
