// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { callApi } from "../api";
import { StepUpForm } from "../security/step-up-form";
import { primaryButtonClass, secondaryButtonClass } from "../ui-classes";

/** Someone who can be given read and manage on the mailbox as part of the conversion. */
export type ConvertCandidate = { userId: string; name: string; email: string };

/**
 * "Convert to shared mailbox" on a person's mailbox (`POST …/convert-to-shared`; ADR-0026 §3). Two steps: the button
 * opens what happens (nobody signs in to it any more: a new password nobody is shown, app passwords revoked, open
 * webmail sessions end; the mail, address and aliases stay and the person stays in the account), with an optional
 * "Give full access to …" and "Also send as" when the viewer may grant (`grant`). The server asks for a fresh
 * confirmation that it's you (403 `step_up_required`) and the conversion is sent again once confirmed. Back again with
 * "Make this a user".
 */
export function ConvertToShared({
  accountId,
  mailboxId,
  address,
  ownerLabel,
  grant,
}: {
  accountId: string;
  mailboxId: string;
  address: string;
  /** The person it belongs to now (name or email). */
  ownerLabel: string;
  /** People who can be given access in the same change, or null when this viewer can't give access. */
  grant: ConvertCandidate[] | null;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [sendAs, setSendAs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const url = `/api/accounts/${encodeURIComponent(accountId)}/mailboxes/${encodeURIComponent(mailboxId)}/convert-to-shared`;

  async function convert() {
    setBusy(true);
    setError(null);
    const res = await callApi(url, {
      method: "POST",
      body: chosen.length > 0 ? { fullAccessTo: chosen, sendAs } : {},
    });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(true);
      else {
        setStepUp(false);
        setError(res.message);
      }
      return;
    }
    setStepUp(false);
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-3">
        <p className="am-body max-w-prose">
          Turn this into a mailbox nobody signs in to, for example when {ownerLabel} leaves or the address becomes a
          team&apos;s. Its mail, address and aliases stay, and {ownerLabel} stays in this account.
        </p>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
          className={`${secondaryButtonClass} w-fit`}
        >
          <Users className="size-4" aria-hidden />
          Convert to shared mailbox…
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border p-4">
      <p className="am-body max-w-prose">
        Convert <span className="font-mono break-all">{address}</span> to a shared mailbox?
      </p>
      <ul className="am-small flex max-w-prose list-disc flex-col gap-1 pl-5">
        <li>
          {ownerLabel} can&apos;t sign in to it any more, in the webmail or mail apps: its password is replaced with one
          nobody is shown, and its app passwords stop working.
        </li>
        <li>Webmail sessions open on it end within a minute.</li>
        <li>Its mail, address and aliases stay. You can make it a user&apos;s mailbox again later.</li>
      </ul>
      {grant ? (
        grant.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="am-h4 mb-1">Give full access to (optional)</legend>
            <ul className="flex flex-col gap-1">
              {grant.map((p) => {
                const boxId = `${id}-${p.userId}`;
                return (
                  <li key={p.userId}>
                    <label htmlFor={boxId} className="flex cursor-pointer items-center gap-3 py-1">
                      <input
                        id={boxId}
                        type="checkbox"
                        checked={chosen.includes(p.userId)}
                        onChange={(e) => {
                          const on = e.target.checked;
                          setChosen((c) => (on ? [...c, p.userId] : c.filter((x) => x !== p.userId)));
                        }}
                        className="size-4 shrink-0 accent-primary"
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-[14px]">{p.name || p.email}</span>
                        <span className="font-mono text-[12.5px] break-all text-muted-foreground">{p.email}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <label className="mt-1 flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={sendAs}
                disabled={chosen.length === 0}
                onChange={(e) => {
                  setSendAs(e.target.checked);
                }}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span className="am-small text-foreground">Also let them send as this mailbox</span>
            </label>
            <p className="am-micro">You can change who has access later on its Delegation tab.</p>
          </fieldset>
        )
      ) : (
        <p className="am-small max-w-prose">
          An owner or a user administrator can give people access to it afterwards, on its Delegation tab.
        </p>
      )}
      {stepUp ? (
        <StepUpForm
          why="Converting a mailbox replaces a password in use, so it needs your console password or a code from the last few minutes."
          onConfirmed={convert}
          onCancel={() => {
            setStepUp(false);
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void convert()} className={primaryButtonClass}>
            {busy ? "Converting…" : "Convert to shared mailbox"}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
            className={secondaryButtonClass}
          >
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
