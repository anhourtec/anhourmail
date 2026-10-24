// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthSplit } from "@/components/auth-split";
import { SignOutButton } from "@/components/sign-out-button";
import { requireUser } from "@/server/console-frame";

import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Choose your own password" };

/**
 * The first-sign-in password change ("Add a user" with "Require password change at first sign-in"): the console sends
 * the person here before anything else until they have replaced the password an admin set (`requireUser`).
 */
export default async function ChangePasswordPage() {
  const actor = await requireUser({ changingPassword: true, enrolling: true });
  if (!actor.mustChangePassword) redirect("/");
  return (
    <AuthSplit>
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">Choose your own password</h1>
        <p className="am-small">
          Your administrator set a password for <span className="font-mono">{actor.email}</span>. Choose a new one that
          only you know before you continue. This changes your console password; your mailbox keeps its own.
        </p>
      </div>
      <ChangePasswordForm />
      <div>
        <SignOutButton />
      </div>
    </AuthSplit>
  );
}
