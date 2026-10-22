// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { AuthSplit, LegalConsent } from "@/components/auth-split";
import { signUpOpen } from "@/server/auth/instance";

import { SignInForm } from "./sign-in-form";

// An invite link can be in this page's query string: never send it on as a referrer.
export const metadata: Metadata = { title: "Sign in", referrer: "no-referrer" };

/** Where sign-in may send people next: only an invite link (no open redirects). */
const NEXT = /^\/invite\/[A-Za-z0-9_-]{43}$/;

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Rendered per request: the sign-up mode is runtime configuration, never baked in at build time.
  await connection();
  const requested = (await searchParams).next;
  const next = typeof requested === "string" && NEXT.test(requested) ? requested : "/";
  return (
    <AuthSplit>
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">Welcome back</h1>
        <p className="am-small">Sign in to manage your mailboxes, domains and aliases.</p>
      </div>
      <SignInForm next={next} />
      <p className="am-micro">Mail apps use app passwords, not this password.</p>
      <LegalConsent verb="signing in" />
      {signUpOpen() && (
        <p className="am-small">
          New to AnhourMail?{" "}
          <Link href="/sign-up" className="font-medium text-foreground underline underline-offset-2">
            Create an account
          </Link>
        </p>
      )}
    </AuthSplit>
  );
}
