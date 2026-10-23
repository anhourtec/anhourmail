// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { type AccountRole, ROLE_LABELS } from "@anhourmail/shared/rbac";

import { callApi } from "../api";
import { inputClass, primaryButtonClass } from "../ui-classes";

/**
 * Invite someone by email with a role the person may grant (Owners: any; User Administrators: Member). The link is
 * emailed; it never appears here.
 */
export function InviteForm({
  accountId,
  roles,
  inviteDays,
}: {
  accountId: string;
  roles: AccountRole[];
  inviteDays: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function send(body: { email: string; role: string }, form: HTMLFormElement) {
    setPending(true);
    setError(null);
    setNotice(null);
    const res = await callApi(`/api/accounts/${accountId}/invites`, { method: "POST", body });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const emailSent = (res.data as { emailSent?: unknown } | undefined)?.emailSent === true;
    setNotice(
      emailSent
        ? `Invite sent to ${body.email.trim().toLowerCase()}. The link works for ${String(inviteDays)} days.`
        : "The invite is saved, but the email couldn't be sent. Use Resend in the invite's menu to try again.",
    );
    form.reset();
    router.refresh();
  }

  function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const field = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };
    void send({ email: field("email"), role: field("role") }, e.currentTarget);
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-5" noValidate>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">Email</span>
          <input
            name="email"
            type="email"
            placeholder="name@example.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            className={inputClass}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="invite-role" className="am-h4">
            Role
          </label>
          <select
            id="invite-role"
            name="role"
            defaultValue="member"
            disabled={roles.length === 1}
            className={inputClass}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[`account:${r}`]}
              </option>
            ))}
          </select>
          {roles.length === 1 && <input type="hidden" name="role" value={roles[0]} />}
        </div>
      </div>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="am-small rounded-lg border bg-muted/40 px-3 py-2.5">
          {notice}
        </p>
      )}
      <button type="submit" disabled={pending} className={`${primaryButtonClass} w-fit`}>
        <Send className="size-4" aria-hidden />
        {pending ? "Sending…" : "Send invite"}
      </button>
    </form>
  );
}
