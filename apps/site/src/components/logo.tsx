// SPDX-License-Identifier: AGPL-3.0-only
import { Wordmark } from "@anhourmail/ui/wordmark";

/**
 * The AnhourMail logo (shared with the apps). `suffix` names a product area; `onDark` is for the night-coloured nav
 * pill and footer, which stay dark in both themes; `logoClassName` sizes the image.
 */
export function Logo({
  suffix,
  className,
  logoClassName,
  onDark = false,
}: {
  suffix?: string;
  className?: string;
  logoClassName?: string;
  onDark?: boolean;
}) {
  return (
    <Wordmark
      {...(suffix ? { suffix } : {})}
      {...(className ? { className } : {})}
      {...(logoClassName ? { logoClassName } : {})}
      tone={onDark ? "onDark" : "auto"}
    />
  );
}
