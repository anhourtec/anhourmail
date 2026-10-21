// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { lookupInvite } from "@anhourmail/core/invite";
import { PLANS } from "@anhourmail/shared/plans";

import { AuthSplit, LegalConsent } from "@/components/auth-split";
import { signUpMode } from "@/server/auth/instance";
import { container } from "@/server/container";

import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create your account" };

/**
 * Sign-up. `closed`: 404. `invite`: only with a valid `?invite=` link (email fixed to the invited address).
 * `open`: anyone; an invite link still pre-fills the email and is redeemed.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const mode = signUpMode();
  if (mode === "closed") notFound();
  const params = await searchParams;
  const token = typeof params.invite === "string" ? params.invite : null;
  const invite = token ? await lookupInvite(container().deps, token) : null;
  const siteUrl = (process.env.SITE_URL ?? "https://anhourmail.com").replace(/\/$/, "");

  if (mode === "invite" && !invite) {
    return (
      <AuthSplit>
        <div className="flex flex-col gap-2">
          <h1 className="am-h1">Sign-up is by invite</h1>
          <p className="am-small">
            {token
              ? "This invite link is invalid, already used or expired."
              : "AnhourMail is invite-only during the beta."}{" "}
            Join the waitlist and we'll email you an invite when a spot opens.
          </p>
        </div>
        <a
          href={`${siteUrl}/waitlist`}
          className="inline-flex h-10 items-center justify-center rounded-lg bg-primary font-medium text-[15px] text-primary-foreground"
        >
          Join the waitlist
        </a>
        <p className="am-small">
          Already have an account?{" "}
          <Link href="/sign-in" className="font-medium text-foreground underline underline-offset-2">
            Sign in
          </Link>
        </p>
      </AuthSplit>
    );
  }

  return (
    <AuthSplit>
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">{invite ? "You're invited" : "Create your account"}</h1>
        <p className="am-small">
          You start on the {PLANS.free.name} plan with {PLANS.free.storageGb} GB. Upgrade any time.
        </p>
      </div>
      <SignUpForm {...(invite && token ? { invite: { token, email: invite.email } } : {})} />
      <LegalConsent verb="creating an account" />
      <p className="am-small">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-foreground underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </AuthSplit>
  );
}
