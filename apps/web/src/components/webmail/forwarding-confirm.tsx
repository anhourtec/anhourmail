// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { CircleCheck } from "lucide-react";
import { useState } from "react";

import { primaryButtonClass } from "@/components/ui-classes";

/** The confirm button for a forwarding link: one POST with the token, then the outcome. */
export function ForwardingConfirm({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "gone" | "error">("idle");
  const [mailbox, setMailbox] = useState("");

  const confirm = async () => {
    setState("busy");
    try {
      const res = await fetch("/api/webmail/forwarding/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.status === 404) {
        setState("gone");
        return;
      }
      if (!res.ok) {
        setState("error");
        return;
      }
      const body = (await res.json()) as { data?: { mailbox?: string } };
      setMailbox(body.data?.mailbox ?? "");
      setState("done");
    } catch {
      setState("error");
    }
  };

  if (state === "done") {
    return (
      <div role="status" className="flex items-start gap-3 rounded-xl border bg-card p-4">
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-[rgb(var(--am-status-success-bg))]" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-medium text-[15px]">Forwarding confirmed</p>
          <p className="am-small">
            {mailbox !== "" ? (
              <>
                The owner of <span className="font-mono">{mailbox}</span> can now turn forwarding on.
              </>
            ) : (
              "The mailbox owner can now turn forwarding on."
            )}{" "}
            You can close this page.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {state === "gone" && (
        <p
          role="alert"
          className="am-small rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-destructive"
        >
          This link has expired or was already used. Ask the mailbox owner to send a new one.
        </p>
      )}
      {state === "error" && (
        <p
          role="alert"
          className="am-small rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-destructive"
        >
          That didn't work. Try again in a moment.
        </p>
      )}
      <button
        type="button"
        disabled={state === "busy" || state === "gone"}
        onClick={() => void confirm()}
        className={primaryButtonClass}
      >
        {state === "busy" ? "Confirming…" : "Confirm forwarding"}
      </button>
    </div>
  );
}
