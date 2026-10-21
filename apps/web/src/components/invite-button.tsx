// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Staff action: invite a confirmed waitlist sign-up (server checks `waitlist.manage`; the UI only hides it). */
export function InviteButton({ entryId, email }: { entryId: string; email: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function invite() {
    setState("sending");
    setMessage(null);
    try {
      const res = await fetch(`/api/platform/waitlist/${encodeURIComponent(entryId)}/invite`, { method: "POST" });
      if (res.ok) {
        router.refresh();
        return;
      }
      setState("error");
      setMessage(res.status === 409 ? "Already invited or not confirmed." : "Couldn't send the invite. Try again.");
    } catch {
      setState("error");
      setMessage("Couldn't reach the server.");
    }
  }

  return (
    <span className="flex items-center gap-2">
      {message && (
        <span role="alert" className="am-micro text-destructive">
          {message}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          void invite();
        }}
        disabled={state === "sending"}
        aria-label={`Invite ${email}`}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] transition-colors hover:bg-accent disabled:opacity-60"
      >
        <Send className="size-3.5" aria-hidden />
        {state === "sending" ? "Sending…" : "Invite"}
      </button>
    </span>
  );
}
