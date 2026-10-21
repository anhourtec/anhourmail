// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { callApi } from "../api";
import { inputClass, primaryButtonClass } from "../ui-classes";

type Options = {
  domains: { id: string; name: string }[];
  members: { userId: string; email: string }[];
  maxQuotaGb: number;
};

/** New mailbox: local part @ one of the account's active domains, optionally for a member, with a quota. */
export function CreateMailboxForm({ accountId, options }: { accountId: string; options: Options }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      },
      e.currentTarget,
    );
  }

  async function create(body: Record<string, string>, form: HTMLFormElement) {
    setPending(true);
    setError(null);
    const res = await callApi(`/api/accounts/${accountId}/mailboxes`, { method: "POST", body });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-xl border p-4 sm:p-5" noValidate>
      <h2 className="am-h3">New mailbox</h2>
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
          <select id="mbx-domain" name="domainId" className={`${inputClass} font-mono sm:max-w-64`}>
            {options.domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
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
            max={options.maxQuotaGb}
            defaultValue={options.maxQuotaGb}
            className={`${inputClass} am-num`}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending} className={`${primaryButtonClass} w-fit`}>
        <Plus className="size-4" aria-hidden />
        {pending ? "Creating…" : "Create mailbox"}
      </button>
    </form>
  );
}
