// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { inlineActionClass } from "../console/flyout";
import { primaryButtonClass } from "../ui-classes";
import { callApi } from "../api";

type CheckResult = { activated: boolean; records: { required: boolean; state: string }[] };

/**
 * Re-checks the records live; the page refreshes with the new states (and the active status when they pass).
 * `inline`: a quiet action link for a details panel's header instead of a primary button.
 */
export function CheckButton({
  accountId,
  domainId,
  inline = false,
}: {
  accountId: string;
  domainId: string;
  inline?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  async function check() {
    setPending(true);
    setMessage(null);
    const res = await callApi(`/api/accounts/${accountId}/domains/${domainId}/check`, { method: "POST" });
    setPending(false);
    if (!res.ok) {
      setMessage({
        tone: "error",
        text: res.status === 429 ? "Checked a lot just now. Wait a minute and try again." : res.message,
      });
      return;
    }
    const result = res.data as CheckResult;
    const missing = result.records.filter((r) => r.required && r.state !== "ok").length;
    setMessage(
      result.activated
        ? { tone: "ok", text: "Verified. Your domain is being set up and will be ready in a minute or two." }
        : missing === 0
          ? { tone: "ok", text: "All required records are in place." }
          : {
              tone: "warn",
              text: `${String(missing)} required ${missing === 1 ? "record is" : "records are"} not in place yet. DNS changes can take a while to show up.`,
            },
    );
    router.refresh();
  }

  return (
    <div className={inline ? "contents" : "flex flex-col items-start gap-2 sm:items-end"}>
      <button
        type="button"
        onClick={() => void check()}
        disabled={pending}
        className={inline ? inlineActionClass : primaryButtonClass}
      >
        <RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} aria-hidden />
        {pending ? "Checking…" : "Check now"}
      </button>
      <p
        role="status"
        aria-live="polite"
        className={`am-small max-w-[42ch] ${inline ? "order-last basis-full" : "sm:text-right"} ${message?.tone === "error" ? "text-destructive" : ""}`}
      >
        {message?.text}
      </p>
    </div>
  );
}
