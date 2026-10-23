// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { AuthSplit } from "@/components/auth-split";

export const metadata: Metadata = { title: "Email address confirmed" };

/**
 * Where the "confirm your email address" link lands (`GET /api/auth/verify-email` redirects here, with `?error=<code>`
 * when the link was invalid or expired). Shows the outcome only; nothing here needs a session.
 */
export default async function EmailVerifiedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const params = await searchParams;
  const failed = params.error !== undefined;
  return (
    <AuthSplit>
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">{failed ? "This link didn't work" : "Email address confirmed"}</h1>
        <p className="am-small">
          {failed
            ? "The link is invalid or has expired. Sign in and send a new one from your Mailboxes page."
            : "Thanks. You can now get your free address from the console."}
        </p>
      </div>
      <Link href="/" className="w-fit font-medium text-primary underline underline-offset-2">
        Go to the console
      </Link>
    </AuthSplit>
  );
}
