// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { AuthSplit } from "@/components/auth-split";

import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : null;
  const invalid = params.error !== undefined || token === null;
  return (
    <AuthSplit>
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">Choose a new password</h1>
        <p className="am-small">Every other signed-in session is signed out when you change it.</p>
      </div>
      {invalid ? (
        <p role="alert" className="am-body rounded-lg border bg-muted px-4 py-3">
          This reset link is invalid or has expired.{" "}
          <Link href="/forgot-password" className="font-medium underline underline-offset-2">
            Send a new link
          </Link>
          .
        </p>
      ) : (
        <ResetPasswordForm token={token} />
      )}
    </AuthSplit>
  );
}
