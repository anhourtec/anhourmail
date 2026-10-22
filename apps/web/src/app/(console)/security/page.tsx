// SPDX-License-Identifier: AGPL-3.0-only
import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getSecurityOverview, type SecurityActivityItem } from "@anhourmail/core/security";
import { PageHeader } from "@anhourmail/ui/page-header";

import { StatusText } from "@/components/console/status-text";
import { PasskeyReviewList, PasskeySettings } from "@/components/security/passkey-settings";
import { SessionList } from "@/components/security/session-list";
import { SignInPolicyForm } from "@/components/security/sign-in-policy";
import { TwoFactorSettings } from "@/components/security/two-factor-settings";
import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";

export const metadata: Metadata = { title: "Security" };

const dateTime = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const dateOnly = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });
const utc = (d: Date) => `${dateTime.format(d)} UTC`;

const METHODS: Record<string, string> = {
  password: "password",
  "password+totp": "password and authenticator code",
  "password+recovery_code": "password and recovery code",
  passkey: "passkey",
  totp: "authenticator code",
  recovery_code: "recovery code",
};

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="am-h3">
          {title}
        </h2>
        {description && <p className="am-small max-w-[80ch]">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function ActivityList({ items }: { items: SecurityActivityItem[] }) {
  if (items.length === 0) return <p className="am-small border-t py-4">No sign-in activity yet.</p>;
  return (
    <ul aria-label="Recent sign-in and security activity" className="border-t">
      {items.map((a) => (
        <li
          key={a.id}
          className="flex min-h-[46px] flex-col gap-0.5 border-b px-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
        >
          <div className="flex min-w-0 flex-col">
            <span className="flex flex-wrap items-center gap-x-2 text-[14px] font-medium">
              {a.result === "success" ? (
                a.label
              ) : (
                <StatusText tone="danger">
                  {a.label}
                  {a.result === "denied" ? " (refused)" : " (failed)"}
                </StatusText>
              )}
            </span>
            <span className="am-micro">
              {[
                a.method ? `With ${METHODS[a.method] ?? a.method}` : null,
                a.byStaff ? "By Anhourtec staff" : null,
                a.device,
              ]
                .filter(Boolean)
                .join(" · ")}
              {a.network && (
                <>
                  {" · "}
                  <span className="font-mono">{a.network}</span>
                </>
              )}
            </span>
          </div>
          <span className="am-micro am-num shrink-0">{utc(a.at)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The person's Security page: how they sign in (authenticator app with recovery codes, passkeys), where they're
 * signed in, and recent sign-in and security activity from the audit log (their own entries only; network part of
 * the address and a browser summary, never secrets). Owners also set their accounts' sign-in requirement here.
 * Reachable while an account requirement is unmet (`?setup=required` is where the console sends them).
 */
export default async function SecurityPage() {
  const { actor, sessionId } = await getActorAndSession(await headers());
  if (actor.kind !== "user") redirect("/sign-in");
  const data = await getSecurityOverview(container().deps, actor, { currentSessionId: sessionId });
  const { factors, requirement } = data;
  const passkeyRows = data.passkeys.map((p) => ({
    id: p.id,
    name: p.name ?? "Passkey",
    added: p.createdAt ? dateOnly.format(p.createdAt) : null,
    synced: p.deviceType === "multiDevice",
  }));
  const requiredBy = requirement.accounts.filter((a) => a.policy === requirement.policy).map((a) => a.name);

  return (
    <>
      <PageHeader
        title="Security"
        description="How you sign in to the console, where you're signed in, and recent sign-in activity. Mail apps use app passwords instead."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Security" }]}
      />

      {data.passwordResetAt && data.passkeys.length > 0 && (
        <div role="status" className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
          <div className="flex gap-3">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="am-h4">Check your passkeys</p>
              <p className="am-small text-foreground">
                Your password was reset on {utc(data.passwordResetAt)}. Passkeys still sign you in on their own: remove
                any you don&apos;t recognise.
              </p>
            </div>
          </div>
          <PasskeyReviewList passkeys={passkeyRows} />
        </div>
      )}

      {requirement.missing && (
        <div role="status" className="flex gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="am-h4">
              {requirement.missing === "passkey"
                ? "Add a passkey to continue"
                : "Set up two-factor sign-in to continue"}
            </p>
            <p className="am-small text-foreground">
              {requiredBy.join(", ")} {requiredBy.length === 1 ? "requires" : "require"}{" "}
              {requirement.missing === "passkey" ? "a passkey or security key" : "an authenticator app or a passkey"}{" "}
              for signing in. The rest of the console opens once it&apos;s set up.
            </p>
          </div>
        </div>
      )}

      <Section
        id="methods"
        title="How you sign in"
        description="Add a second step after your password, or a passkey that signs you in on its own."
      >
        <div className="flex flex-col gap-6 border-t pt-4">
          <TwoFactorSettings enabled={factors.totp} recoveryCodesLeft={factors.recoveryCodesLeft} />
          <div className="border-t pt-4">
            <PasskeySettings passkeys={passkeyRows} />
          </div>
        </div>
      </Section>

      <Section
        id="sessions"
        title="Where you're signed in"
        description="Console sessions. Signing one out ends it right away; signing out everywhere else also forgets trusted browsers."
      >
        <SessionList
          hasPasskeys={data.passkeys.length > 0}
          sessions={data.sessions.map((s) => ({
            id: s.id,
            device: s.device,
            network: s.network,
            signedIn: utc(s.createdAt),
            lastActive: utc(s.lastActiveAt),
            current: s.current,
          }))}
        />
      </Section>

      <Section
        id="activity"
        title="Recent activity"
        description="Sign-ins and changes to how you sign in, newest first. Addresses show only their network part."
      >
        <ActivityList items={data.activity} />
      </Section>

      {data.manageable.length > 0 && (
        <Section
          id="requirements"
          title="Sign-in requirements"
          description="As an Owner, you can require a second step or a passkey for everyone in an account. You need to meet it yourself first."
        >
          <div className="flex flex-col gap-6 border-t pt-4">
            {data.manageable.map((a) => (
              <SignInPolicyForm key={a.id} accountId={a.id} accountName={a.name} policy={a.policy} />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
