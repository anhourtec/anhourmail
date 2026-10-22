// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";

import { lookupInvite } from "@anhourmail/core/people";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";

import { AuthSplit } from "@/components/auth-split";
import { SignOutButton } from "@/components/sign-out-button";
import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";

import { AcceptInvite } from "./accept-invite";

// The token is in this page's URL: never send it on as a referrer.
export const metadata: Metadata = { title: "Join an account", referrer: "no-referrer" };

function Invalid({ expired }: { expired: boolean }) {
  return (
    <p role="alert" className="am-body rounded-lg border bg-muted px-4 py-3">
      {expired
        ? "This invite has expired. Ask the person who invited you to send it again."
        : "This invite link has expired, been used or been revoked. Ask the person who invited you for a new one."}{" "}
      <Link href="/sign-in" className="font-medium underline underline-offset-2">
        Sign in
      </Link>
    </p>
  );
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  const invite = await lookupInvite(container().deps, token);
  const actor = await getActor(await headers());
  const role = invite ? ROLE_LABELS[`account:${invite.role}`] : "";

  return (
    <AuthSplit>
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">{invite ? `Join ${invite.accountName}` : "Join an account"}</h1>
        {invite && !invite.expired && (
          <p className="am-small">
            You&apos;re invited as <span className="text-foreground">{role}</span>. The invite is for{" "}
            <code className="am-code break-all text-foreground">{invite.email}</code>.
          </p>
        )}
      </div>
      {!invite || invite.expired ? (
        <Invalid expired={invite?.expired ?? false} />
      ) : actor.kind === "user" ? (
        actor.email.toLowerCase() === invite.email ? (
          <AcceptInvite token={token} mode="join" accountName={invite.accountName} />
        ) : (
          <div className="flex flex-col gap-3">
            <p role="alert" className="am-body rounded-lg border bg-muted px-4 py-3">
              You&apos;re signed in as <code className="am-code break-all">{actor.email}</code>, but this invite is for
              a different address. Sign out, then open the link again.
            </p>
            <div>
              <SignOutButton />
            </div>
          </div>
        )
      ) : invite.hasLogin ? (
        <p className="am-body rounded-lg border bg-muted px-4 py-3">
          You already have an AnhourMail login.{" "}
          <Link
            href={`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`}
            className="font-medium underline underline-offset-2"
          >
            Sign in as {invite.email}
          </Link>{" "}
          to accept.
        </p>
      ) : (
        <AcceptInvite token={token} mode="create" accountName={invite.accountName} />
      )}
    </AuthSplit>
  );
}
