// SPDX-License-Identifier: AGPL-3.0-only
import { SharedMailboxSkeleton } from "@/components/webmail/mailbox-skeleton";

/** Mirrors a mailbox shared with the person in its own tab: sidebar · list · reader. */
export default function Loading() {
  return <SharedMailboxSkeleton />;
}
