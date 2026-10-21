// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The AnhourMail wordmark: uppercase, wide-tracked display face to sit alongside the Anhourtec logo
 * (branding.md "Wordmark"), text only — no square or dot before it. The accessible name stays "AnhourMail" — CSS does the uppercasing.
 * `suffix` adds a quiet, sentence-case product area (e.g. "Webmail") after a hairline.
 */
export function Wordmark({ suffix, className = "" }: { suffix?: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="font-display font-medium text-[14px] uppercase leading-none tracking-[0.18em]">AnhourMail</span>
      {suffix && (
        <>
          <span aria-hidden className="h-3.5 w-px bg-border" />
          <span className="text-[13px] text-muted-foreground leading-none">{suffix}</span>
        </>
      )}
    </span>
  );
}
