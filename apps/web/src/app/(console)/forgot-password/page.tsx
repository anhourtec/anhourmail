// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { AuthSplit } from "@/components/auth-split";

import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Reset your password" };

export default async function ForgotPasswordPage() {
  // Rendered per request: runtime configuration (sign-up mode, site URL) is never baked in at build time.
  await connection();
  return (
    <AuthSplit>
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">Reset your password</h1>
        <p className="am-small">Enter the email you sign in with. We'll send a link that works for one hour.</p>
      </div>
      <ForgotPasswordForm />
      <p className="am-small">
        Remembered it?{" "}
        <Link href="/sign-in" className="font-medium text-foreground underline underline-offset-2">
          Back to sign in
        </Link>
      </p>
    </AuthSplit>
  );
}
