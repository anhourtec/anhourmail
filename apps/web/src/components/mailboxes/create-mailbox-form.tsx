// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { PLATFORM_ADDRESS } from "@anhourmail/shared/addresses";
import { poolFullMessage } from "@anhourmail/shared/storage";

import { callApi } from "../api";
import { inputClass, primaryButtonClass } from "../ui-classes";
import { MailboxPasswordField } from "./mailbox-password-field";

type Options = {
  domains: { id: string; name: string }[];
  /** The platform domain (free addresses; ADR-0021): offered while the plan has room for another. */
  platform: { id: string; domain: string; used: number; max: number | null; allowed: boolean };
  members: { userId: string; email: string }[];
  /** The account's unassigned storage in whole GB (0: fully assigned) and the default share for a new mailbox. */
  maxQuotaGb: number;
  defaultQuotaGb: number;
  pool: { poolBytes: number };
};

/**
 * New mailbox (in the "Add a mailbox" panel): local part @ one of the account's active domains or the platform domain
 * (a free address, with its own naming rules and the plan's allowance), optionally for a member, with a quota and the
 * password its person signs in to the webmail with (typed or generated, shown once). The panel stays open after
 * creating one, so several can be added in a row.
 */
export function CreateMailboxForm({ accountId, options }: { accountId: string; options: Options }) {
  const router = useRouter();
  const choices = [
    ...options.domains.map((d) => ({ id: d.id, name: d.name, free: false })),
    ...(options.platform.allowed ? [{ id: options.platform.id, name: options.platform.domain, free: true }] : []),
  ];
  const [domainId, setDomainId] = useState(choices[0]?.id ?? "");
  const onPlatform = domainId === options.platform.id;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const poolFull = options.maxQuotaGb < 1;

  function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const field = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    void create(
      {
        localPart: field("localPart"),
        domainId: field("domainId"),
        ownerUserId: field("ownerUserId"),
        quotaGb: field("quotaGb"),
        password,
      },
      e.currentTarget,
    );
  }

  async function create(body: Record<string, string>, form: HTMLFormElement) {
    setPending(true);
    setError(null);
    setCreated(null);
    const res = await callApi(`/api/accounts/${accountId}/mailboxes`, { method: "POST", body });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const address = (res.data as { address?: unknown } | undefined)?.address;
    setCreated(typeof address === "string" ? address : "The mailbox");
    form.reset();
    setPassword("");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-5" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="mbx-local" className="am-h4">
          Address
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            id="mbx-local"
            name="localPart"
            placeholder="jane"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            className={`${inputClass} font-mono sm:max-w-56`}
          />
          <span aria-hidden className="am-code hidden sm:inline">
            @
          </span>
          <label htmlFor="mbx-domain" className="sr-only">
            Domain
          </label>
          <select
            id="mbx-domain"
            name="domainId"
            value={domainId}
            onChange={(e) => {
              setDomainId(e.target.value);
            }}
            className={`${inputClass} font-mono sm:max-w-64`}
          >
            {choices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.free ? `${d.name} (free address)` : d.name}
              </option>
            ))}
          </select>
        </div>
        {onPlatform && (
          <p className="am-micro">
            Free addresses at <span className="am-code">{options.platform.domain}</span>: {PLATFORM_ADDRESS.min}–
            {PLATFORM_ADDRESS.max} characters, first come, first served.
            {options.platform.max !== null &&
              ` This plan includes ${options.platform.max === 1 ? "one free address" : `${String(options.platform.max)} free addresses`}.`}
          </p>
        )}
        {!options.platform.allowed && options.platform.max !== null && (
          <p className="am-micro">
            This plan&apos;s free <span className="am-code">@{options.platform.domain}</span>{" "}
            {options.platform.max === 1 ? "address is" : "addresses are"} already in use.
          </p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">Belongs to</span>
          <select name="ownerUserId" className={inputClass}>
            <option value="">Nobody yet</option>
            {options.members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.email}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">Storage (GB)</span>
          <input
            name="quotaGb"
            type="number"
            inputMode="numeric"
            min={1}
            max={Math.max(1, options.maxQuotaGb)}
            defaultValue={options.defaultQuotaGb || ""}
            disabled={poolFull}
            aria-describedby="new-quota-hint"
            className={`${inputClass} am-num`}
          />
          <span id="new-quota-hint" className={`am-micro ${poolFull ? "text-destructive" : ""}`}>
            {poolFull ? (
              poolFullMessage(options.pool.poolBytes)
            ) : (
              <>
                <span className="am-num">{options.maxQuotaGb} GB</span> of the account&apos;s storage is unassigned.
              </>
            )}
          </span>
        </label>
      </div>
      <MailboxPasswordField value={password} onChange={setPassword} />
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {created && (
        <p role="status" className="am-small rounded-lg border bg-muted/40 px-3 py-2.5">
          Created <span className="am-code break-all text-foreground">{created}</span>. It&apos;s set up on the mail
          server within a minute; after that, the webmail sign-in takes the password you set. Add another, or close this
          panel.
        </p>
      )}
      <button type="submit" disabled={pending || poolFull} className={`${primaryButtonClass} w-fit`}>
        <Plus className="size-4" aria-hidden />
        {pending ? "Creating…" : "Create mailbox"}
      </button>
    </form>
  );
}
