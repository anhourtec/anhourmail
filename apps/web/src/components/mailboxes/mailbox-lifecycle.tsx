// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Pause, Play, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { callApi } from "../api";
import { dangerButtonClass, secondaryButtonClass } from "../ui-classes";

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });
const DAY_MS = 24 * 3600_000;

/** One call to a mailbox action; refreshes the page on success, returns the error message otherwise. */
function useMailboxAction(accountId: string, mailboxId: string) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/accounts/${accountId}/mailboxes/${mailboxId}`;

  async function run(action: "suspend" | "resume" | "restore" | "delete"): Promise<boolean> {
    setPending(true);
    setError(null);
    const res = await callApi(action === "delete" ? base : `${base}/${action}`, {
      method: action === "delete" ? "DELETE" : "POST",
    });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return false;
    }
    router.refresh();
    return true;
  }
  return { pending, error, run };
}

/** The worker gave up applying a suspension or deletion: say so plainly and offer to try again. */
function NotApplied({ pending, onRetry, what }: { pending: boolean; onRetry: () => void; what: string }) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive/40 p-3">
      <p className="am-small">
        Not applied on the mail server yet: the last attempt to {what} failed, so people may still be able to sign in to
        this mailbox.
      </p>
      <button type="button" disabled={pending} onClick={onRetry} className={`${secondaryButtonClass} w-fit`}>
        <RefreshCw className="size-4" aria-hidden />
        {pending ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="am-small text-destructive">
      {error}
    </p>
  ) : null;
}

/** Suspend or resume sign-in and delivery. Reversible, so one click; the worker applies it within a minute. */
export function SuspendMailbox({
  accountId,
  mailboxId,
  suspended,
  applyFailed = false,
}: {
  accountId: string;
  mailboxId: string;
  suspended: boolean;
  applyFailed?: boolean;
}) {
  const { pending, error, run } = useMailboxAction(accountId, mailboxId);
  return (
    <div className="flex flex-col gap-3">
      {suspended && applyFailed && (
        <NotApplied pending={pending} what="suspend it" onRetry={() => void run("suspend")} />
      )}
      <p className="am-body max-w-prose">
        {suspended
          ? "Suspended: nobody can sign in to this mailbox, in webmail or mail apps, and mail sent to it or its aliases is refused. Nothing in it has been deleted."
          : "Suspending stops all sign-ins to this mailbox, in webmail and mail apps, and refuses mail sent to it or its aliases. Nothing in it is deleted, and you can resume it at any time."}
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => void run(suspended ? "resume" : "suspend")}
        className={`${secondaryButtonClass} w-fit`}
      >
        {suspended ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
        {suspended ? (pending ? "Resuming…" : "Resume mailbox") : pending ? "Suspending…" : "Suspend mailbox"}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

/**
 * Two-step delete (no browser dialogs). Says plainly that it's recoverable until the purge date, which is computed
 * when the person asks to delete (so the server and browser never disagree about "today").
 */
export function DeleteMailbox({
  accountId,
  mailboxId,
  address,
  graceDays,
}: {
  accountId: string;
  mailboxId: string;
  address: string;
  graceDays: number;
}) {
  const { pending, error, run } = useMailboxAction(accountId, mailboxId);
  const [purgeOn, setPurgeOn] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {purgeOn ? (
        <div className="flex flex-col gap-3 rounded-xl border border-destructive/40 p-4">
          <p className="am-body max-w-prose">
            Delete <code className="am-code break-all">{address}</code>? It&apos;s suspended straight away: nobody can
            sign in and mail to it and its aliases is refused. Everything in it is kept, and you can restore it until{" "}
            <span className="am-num">{purgeOn}</span>. After that the mailbox, its aliases and all its mail are
            permanently deleted.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                void run("delete").then((done) => {
                  if (done) setPurgeOn(null);
                });
              }}
              className={dangerButtonClass}
            >
              <Trash2 className="size-4" aria-hidden />
              {pending ? "Deleting…" : "Delete mailbox"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPurgeOn(null);
              }}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="am-body max-w-prose">
            Deleted mailboxes can be restored for {graceDays} days. After that they&apos;re removed for good, with all
            their mail.
          </p>
          <button
            type="button"
            onClick={() => {
              setPurgeOn(dateFmt.format(new Date(Date.now() + graceDays * DAY_MS)));
            }}
            className={`${dangerButtonClass} w-fit`}
          >
            <Trash2 className="size-4" aria-hidden />
            Delete mailbox…
          </button>
        </>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

/** Restore a mailbox during its grace period: access and its aliases come back once the worker has applied it. */
export function RestoreMailbox({
  accountId,
  mailboxId,
  purgeOn,
  applyFailed = false,
}: {
  accountId: string;
  mailboxId: string;
  purgeOn: string;
  applyFailed?: boolean;
}) {
  const { pending, error, run } = useMailboxAction(accountId, mailboxId);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-destructive/40 p-4">
      {applyFailed && <NotApplied pending={pending} what="switch it off" onRetry={() => void run("delete")} />}
      <p className="am-body max-w-prose">
        This mailbox is being deleted. Nobody can sign in and its mail is refused, but everything in it is kept until{" "}
        <span className="am-num">{purgeOn}</span>, when it&apos;s permanently deleted with its aliases. Restore it to
        turn it back on.
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => void run("restore")}
        className={`${secondaryButtonClass} w-fit`}
      >
        <RotateCcw className="size-4" aria-hidden />
        {pending ? "Restoring…" : "Restore mailbox"}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}
