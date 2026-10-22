// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The AnhourMail logo (packages/ui/assets/brand, synced to each app's public/): ink with a blue envelope on light
 * surfaces, white with a cyan envelope on dark ones. `tone="auto"` follows the theme (both images render and the
 * `dark` class picks one, no JS); `tone="onDark"` is for surfaces that stay dark in both themes (the site's nav
 * pill and footer, the console app bar), where only the dark-surface logo is readable.
 * `suffix` adds a quiet, sentence-case product area (e.g. "Webmail") after a hairline.
 */
export function Wordmark({
  suffix,
  className = "",
  logoClassName = "h-3.5 w-auto",
  tone = "auto",
}: {
  suffix?: string;
  className?: string;
  logoClassName?: string;
  tone?: "auto" | "onDark";
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      {tone === "onDark" ? (
        <img src="/anhourmail-logo-dark.svg" alt="AnhourMail" className={logoClassName} />
      ) : (
        <>
          <img src="/anhourmail-logo-light.svg" alt="AnhourMail" className={`${logoClassName} dark:hidden`} />
          <img src="/anhourmail-logo-dark.svg" alt="" aria-hidden className={`${logoClassName} hidden dark:block`} />
        </>
      )}
      {suffix && (
        <>
          <span aria-hidden className="h-3.5 w-px bg-border" />
          <span className="text-[13px] text-muted-foreground leading-none">{suffix}</span>
        </>
      )}
    </span>
  );
}
