// SPDX-License-Identifier: AGPL-3.0-only
import { Wordmark } from "@anhourmail/ui/wordmark";

/** The AnhourMail wordmark (uppercase, wide-tracked; shared with the apps). `suffix` names a product area. */
export function Logo({ suffix, className }: { suffix?: string; className?: string }) {
  return <Wordmark {...(suffix ? { suffix } : {})} {...(className ? { className } : {})} />;
}
