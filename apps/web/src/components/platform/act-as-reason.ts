// SPDX-License-Identifier: AGPL-3.0-only
import { ACT_AS } from "@anhourmail/shared/platform";

/**
 * Why a support-access reason can't be sent yet, or null when it can. Shown next to the button on submit instead of
 * leaving the button silently disabled (staff couldn't tell that a short reason was the problem). The server checks
 * the same limits (`startActAs` / renew).
 */
export function reasonProblem(reason: string): string | null {
  const length = reason.trim().length;
  if (length === 0) return "Write a reason first.";
  if (length < ACT_AS.reasonMin) {
    const more = ACT_AS.reasonMin - length;
    return `Write a little more: the reason needs at least ${String(ACT_AS.reasonMin)} characters (${String(more)} more).`;
  }
  if (length > ACT_AS.reasonMax) return `Keep the reason to ${String(ACT_AS.reasonMax)} characters.`;
  return null;
}
