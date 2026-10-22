// SPDX-License-Identifier: AGPL-3.0-only
import { CircleCheck, CircleMinus, CircleX, Info, type LucideIcon, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

export type Tone = "success" | "info" | "warning" | "danger" | "neutral";

const TONES: Record<Tone, { icon: LucideIcon; className: string }> = {
  success: { icon: CircleCheck, className: "text-[rgb(var(--am-status-success))]" },
  info: { icon: Info, className: "text-primary" },
  warning: { icon: TriangleAlert, className: "text-[rgb(var(--am-status-warning))]" },
  danger: { icon: CircleX, className: "text-[rgb(var(--am-status-danger))]" },
  neutral: { icon: CircleMinus, className: "text-muted-foreground" },
};

/** Status in lists and panels: a small coloured icon and plain text ("Active", "Waiting for DNS"). */
export function StatusText({
  tone,
  children,
  className = "",
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  const t = TONES[tone];
  const Icon = t.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[14px] text-foreground ${className}`}>
      <Icon className={`size-4 shrink-0 ${t.className}`} aria-hidden />
      <span>{children}</span>
    </span>
  );
}
