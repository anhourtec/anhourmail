// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PLANS } from "@anhourmail/shared/plans";

import { AuthSplit, LegalConsent } from "@/components/auth-split";
import { signUpOpen } from "@/server/auth/instance";

import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create your account" };

export default function SignUpPage() {
  if (!signUpOpen()) notFound();
  return (
    <AuthSplit>
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">Create your account</h1>
        <p className="am-small">
          You start on the {PLANS.free.name} plan with {PLANS.free.storageGb} GB. Upgrade any time.
        </p>
      </div>
      <SignUpForm />
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
