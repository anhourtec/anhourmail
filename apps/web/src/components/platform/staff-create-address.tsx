// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { AtSign } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useId, useState } from "react";

import { PLATFORM_ADDRESS, platformLocalPartProblem } from "@anhourmail/shared/addresses";

import { callApi } from "../api";
import { inputClass, primaryButtonClass } from "../ui-classes";

/**
 * Staff (Global Administrator): create a free platform-domain address in this customer account, optionally for one of
 * its people. No password is set here — staff never choose a customer's mailbox password; the account's Owner or User
 * Administrator sets it from the mailbox. Recorded in the account's audit log as a staff action, which its admins see.
 */
export function StaffCreateAddress({
  accountId,
  domain,
  people,
}: {
  accountId: string;
  domain: string;
  people: { userId: string; email: string }[];
}) {
  const id = useId();
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const problem = name.trim() === "" ? null : platformLocalPartProblem(name);

  async function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const owner = new FormData(e.currentTarget).get("ownerUserId");
    setPending(true);
    setError(null);
    setCreated(null);
    const res = await callApi(`/api/platform/accounts/${accountId}/mailboxes`, {
      method: "POST",
      body: { localPart: name.trim(), ...(typeof owner === "string" && owner !== "" ? { ownerUserId: owner } : {}) },
    });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const address = (res.data as { address?: unknown } | undefined)?.address;
    setCreated(typeof address === "string" ? address : `${name.trim().toLowerCase()}@${domain}`);
    setName("");
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-labelledby={`${id}-title`}
      className="mb-4 flex flex-col gap-4 rounded-lg border px-4 py-4"
      noValidate
    >
      <div className="flex flex-col gap-1">
        <h3 id={`${id}-title`} className="am-h4">
          Create a free @{domain} address
        </h3>
        <p className="am-small max-w-prose">
          Staff action, recorded in this account&apos;s audit log. No password is set: the account&apos;s Owner or User
          Administrator sets it from the mailbox. Same rules as the customer&apos;s own: {PLATFORM_ADDRESS.min}–
          {PLATFORM_ADDRESS.max} characters, reserved names refused, the plan&apos;s free-address allowance.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className="am-h4">
            Address
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`${id}-name`}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={PLATFORM_ADDRESS.max + 8}
              aria-describedby={`${id}-problem`}
              className={`${inputClass} font-mono`}
            />
            <span className="am-code shrink-0">@{domain}</span>
          </div>
          <p id={`${id}-problem`} className="am-micro min-h-4 text-destructive">
            {problem}
          </p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">Belongs to</span>
          <select name="ownerUserId" className={inputClass}>
            <option value="">Nobody yet</option>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.email}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {created && (
        <p role="status" className="am-small rounded-lg border bg-muted/40 px-3 py-2.5">
          Created <span className="am-code break-all text-foreground">{created}</span>. It has no password yet; the
          account sets one from its Mailboxes page.
        </p>
      )}
      <button
        type="submit"
        disabled={pending || name.trim() === "" || problem !== null}
        className={`${primaryButtonClass} w-fit`}
      >
        <AtSign className="size-4" aria-hidden />
        {pending ? "Creating…" : "Create address"}
      </button>
    </form>
  );
}
