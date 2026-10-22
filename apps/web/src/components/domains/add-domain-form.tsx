// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { inputClass, primaryButtonClass } from "../ui-classes";
import { callApi } from "../api";

/** Add a domain (in the "Add a domain" panel), then open its details panel with the records to publish. */
export function AddDomainForm({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = new FormData(e.currentTarget).get("name");
    void add(typeof value === "string" ? value.trim() : "");
  }

  async function add(name: string) {
    setPending(true);
    setError(null);
    const res = await callApi(`/api/accounts/${accountId}/domains`, {
      method: "POST",
      body: { name },
    });
    if (res.ok) {
      router.push(`/accounts/${accountId}/domains?domain=${encodeURIComponent((res.data as { id: string }).id)}`, {
        scroll: false,
      });
      return;
    }
    setPending(false);
    setError(res.message);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate>
      <label htmlFor="domain-name" className="am-h4">
        Domain name
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="domain-name"
          name="name"
          placeholder="example.org"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-describedby={error ? "domain-error" : "domain-hint"}
          className={`${inputClass} font-mono sm:max-w-sm`}
        />
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          <Plus className="size-4" aria-hidden />
          {pending ? "Adding…" : "Add domain"}
        </button>
      </div>
      {error ? (
        <p id="domain-error" role="alert" className="am-small text-destructive">
          {error}
        </p>
      ) : (
        <p id="domain-hint" className="am-micro">
          A domain you own. You'll add a few DNS records next; nothing changes until they're in place.
        </p>
      )}
    </form>
  );
}
