// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { PLANS } from "@anhourmail/shared/plans";

import { AuthSplit, LegalConsent } from "@/components/auth-split";
import { signUpOpen } from "@/server/auth/instance";
import { looksLikeInviteCode } from "@/server/auth/sign-up-code";

import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create your account" };

/**
 * Sign-up. `open`: anyone who can reach the console, with an optional invite code (`?code=`, ADR-0029 §8) that may comp
 * a paid plan. `SIGNUP_MODE=closed`: 404, unless the link carries something shaped like an invite code; the code itself
 * is checked with the sign-up, after the proof-of-work (one answer for every wrong code).
 */
export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  // Rendered per request: runtime configuration (sign-up mode, site URL) is never baked in at build time.
  await connection();
  const raw = (await searchParams).code;
  const code = typeof raw === "string" ? raw.trim().slice(0, 64) : null;
  const open = signUpOpen();
  if (!open && !looksLikeInviteCode(code)) notFound();

  return (
    <AuthSplit>
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">Create your account</h1>
        <p className="am-small">
          You start on the {PLANS.free.name} plan with {PLANS.free.storagePoolGb} GB of storage. Upgrade any time.
        </p>
      </div>
      <SignUpForm inviteCode={looksLikeInviteCode(code) ? code : null} codeRequired={!open} />
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
