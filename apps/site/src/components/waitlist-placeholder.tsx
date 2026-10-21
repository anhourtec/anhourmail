// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";

/**
 * Waitlist form UI. Disabled until Phase 2 wires it to POST /api/public/waitlist (same-origin via the
 * rewrite in next.config.mjs). The field names match WaitlistSignupSchema in @anhourmail/shared.
 */
export function WaitlistPlaceholder() {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3">
      <form aria-describedby="waitlist-status" className="mt-2 flex w-full max-w-md flex-col gap-3 sm:flex-row">
        <label htmlFor="waitlist-email" className="sr-only">
          Email address
        </label>
        <input
          id="waitlist-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          disabled
          className="h-[45px] flex-1 rounded-lg border border-white/15 bg-white/5 px-4 text-sm text-white placeholder:text-white/50 disabled:cursor-not-allowed"
        />
        <button type="submit" disabled className="am-site-btn am-site-btn--primary">
          Opens soon
        </button>
        <p id="waitlist-status" className="sr-only">
          The waitlist is not open yet.
        </p>
      </form>
      <p className="text-[12.5px] text-white/55">
        By joining the waitlist, you agree to our{" "}
        <Link href="/legal/terms" className="underline underline-offset-2 hover:text-white">
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href="/legal/privacy" className="underline underline-offset-2 hover:text-white">
          Privacy Policy
        </Link>
        .
      </p>
    </div>
  );
}
