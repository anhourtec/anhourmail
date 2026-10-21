// SPDX-License-Identifier: AGPL-3.0-only
import { ThemeSwitch } from "@anhourmail/ui/theme-switch";

/**
 * Light / Dark / System switch for the site and docs (shared component, branding.md "Dark mode").
 * `onDark` restyles it for the night-coloured floating nav pill (site.css `.am-site-nav-theme`).
 */
export function ThemeToggle({ onDark = false }: { onDark?: boolean }) {
  return <ThemeSwitch className={onDark ? "am-site-nav-theme border-white/15" : ""} />;
}
