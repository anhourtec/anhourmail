// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { AuthSplit, LegalConsent } from "@/components/auth-split";
import { signUpOpen } from "@/server/auth/instance";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <AuthSplit>
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">Welcome back</h1>
        <p className="am-small">Sign in to manage your mailboxes, domains and aliases.</p>
      </div>
      <SignInForm />
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
