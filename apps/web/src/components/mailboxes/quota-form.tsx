// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { callApi } from "../api";
import { inputClass, secondaryButtonClass } from "../ui-classes";

/** Change a mailbox's storage quota (whole GB, up to the plan's storage). */
export function QuotaForm({
  accountId,
  mailboxId,
  currentGb,
  maxGb,
}: {
  accountId: string;
  mailboxId: string;
  currentGb: number;
  maxGb: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = new FormData(e.currentTarget).get("quotaGb");
    void save(typeof v === "string" ? v.trim() : "");
  }

  async function save(quotaGb: string) {
    setPending(true);
    setMessage(null);
    const res = await callApi(`/api/accounts/${accountId}/mailboxes/${mailboxId}`, {
      method: "PATCH",
      body: { quotaGb },
    });
    setPending(false);
    setMessage(
      res.ok ? { error: false, text: "Saved. The new quota applies in a minute." } : { error: true, text: res.message },
    );
    if (res.ok) router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate>
      <label htmlFor="quota" className="am-h4">
        Storage (GB)
      </label>
      <div className="flex gap-2">
        <input
          id="quota"
          name="quotaGb"
          type="number"
          inputMode="numeric"
          min={1}
          max={maxGb}
          defaultValue={currentGb}
          aria-describedby="quota-hint"
          className={`${inputClass} am-num max-w-32`}
        />
        <button type="submit" disabled={pending} className={secondaryButtonClass}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <p id="quota-hint" className="am-micro">
        From 1 to {maxGb} GB on this plan.
      </p>
      <p role="status" aria-live="polite" className={`am-small ${message?.error ? "text-destructive" : ""}`}>
        {message?.text}
      </p>
    </form>
  );
}
