// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { callApi } from "../api";
import { StatusText } from "../console/status-text";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";

/**
 * A domain's catch-all: off, or one mailbox of the account that gets mail sent to addresses that don't exist at the
 * domain. Spam finds catch-alls quickly (it tries made-up names), so the warning is part of the form, not a footnote.
 */
export function CatchAllForm({
  accountId,
  domainId,
  domain,
  current,
  mailboxes,
}: {
  accountId: string;
  domainId: string;
  domain: string;
  current: { id: string; address: string } | null;
  mailboxes: { id: string; address: string }[];
}) {
  const router = useRouter();
  const id = useId();
  const [choice, setChoice] = useState(current?.id ?? mailboxes[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const url = `/api/accounts/${encodeURIComponent(accountId)}/domains/${encodeURIComponent(domainId)}/catch-all`;

  async function save(mailboxId: string | null) {
    setPending(true);
    setError(null);
    setDone(null);
    const res = await callApi(url, { method: "PUT", body: { mailboxId } });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setDone(mailboxId ? "Catch-all is on. It takes effect within a minute." : "Catch-all is off.");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="am-body max-w-prose">
        {current ? (
          <>
            On: mail to any address at <span className="font-mono">{domain}</span> that doesn&apos;t exist goes to{" "}
            <span className="font-mono">{current.address}</span>.
          </>
        ) : (
          <>
            Off: mail to an address at <span className="font-mono">{domain}</span> that doesn&apos;t exist is refused,
            and the sender is told.
          </>
        )}
      </p>
      <div className="flex max-w-prose gap-2.5 rounded-lg border border-l-4 border-l-[rgb(var(--am-status-warning))] px-3.5 py-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[rgb(var(--am-status-warning))]" aria-hidden />
        <p className="am-small text-foreground">
          A catch-all receives a lot of spam: spammers send to made-up names to find domains that accept everything.
          Turn it on only if you need it, and prefer aliases for addresses you hand out.
        </p>
      </div>
      {mailboxes.length === 0 ? (
        <p className="am-small">This account has no active mailbox to send it to yet.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(choice);
          }}
          className="flex max-w-md flex-col gap-3"
        >
          <label htmlFor={`${id}-mailbox`} className="am-h4">
            Send unknown addresses to
          </label>
          <select
            id={`${id}-mailbox`}
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value);
            }}
            className={`${inputClass} font-mono`}
          >
            {mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.address}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending || choice === "" || choice === current?.id}
              className={primaryButtonClass}
            >
              {pending ? "Saving…" : current ? "Change catch-all" : "Turn on catch-all"}
            </button>
            {current && (
              <button type="button" disabled={pending} onClick={() => void save(null)} className={secondaryButtonClass}>
                Turn off
              </button>
            )}
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {done && (
        <div role="status">
          <StatusText tone="success">{done}</StatusText>
        </div>
      )}
    </div>
  );
}
