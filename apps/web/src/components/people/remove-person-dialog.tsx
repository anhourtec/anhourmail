// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useState } from "react";

import { callApi } from "../api";
import { ConfirmDialog } from "../console/flyout";
import { StepUpForm } from "../security/step-up-form";
import { inputClass } from "../ui-classes";

/** Someone in the account who could be given full access to the leaver's mailboxes. */
export type HandOverCandidate = { userId: string; name: string; email: string };

/**
 * What the removal dialog offers for the leaver's mailboxes (ADR-0026 §5): `grant` — "Give full access to …" (the viewer
 * may give access and the plan includes it), `later` — a line that an owner can do it afterwards, or nothing.
 */
export type HandOver = { kind: "grant"; candidates: HandOverCandidate[] } | { kind: "later" } | null;

/**
 * "Remove someone" for one person (`DELETE /api/accounts/:accountId/people/:userId`). Their mailboxes stay, as shared
 * mailboxes with their sign-in turned off. With `handOver.kind === "grant"` and mailboxes to hand over, an optional step
 * gives one person read and manage (and, if ticked, send as) on each of them in the removal's own change; that part
 * needs a fresh confirmation that it's you (403 `step_up_required`), after which the removal is sent again. Without a
 * choice it's the plain removal.
 */
export function RemovePersonDialog({
  accountId,
  userId,
  label,
  mailboxes,
  handOver,
  onCancel,
  onRemoved,
}: {
  accountId: string;
  userId: string;
  /** Name or email, for the title. */
  label: string;
  /** Addresses of the mailboxes they own (null when the viewer can't see mailboxes). */
  mailboxes: string[] | null;
  handOver: HandOver;
  onCancel: () => void;
  onRemoved: () => void;
}) {
  const id = useId();
  const [to, setTo] = useState("");
  const [sendAs, setSendAs] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owned = mailboxes ?? [];
  const one = owned.length === 1;
  const candidates = handOver?.kind === "grant" ? handOver.candidates.filter((p) => p.userId !== userId) : [];
  const offer = owned.length > 0 && candidates.length > 0;

  async function remove(): Promise<string | null> {
    setError(null);
    const res = await callApi(`/api/accounts/${encodeURIComponent(accountId)}/people/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      ...(offer && to !== "" ? { body: { delegateTo: { userId: to, sendAs } } } : {}),
    });
    if (!res.ok) {
      if (res.code === "step_up_required") {
        setStepUp(true);
        return null;
      }
      return res.message;
    }
    onRemoved();
    return null;
  }

  return (
    <ConfirmDialog
      title={`Remove ${label}?`}
      confirmLabel="Remove"
      pendingLabel="Removing…"
      onCancel={onCancel}
      onConfirm={remove}
      actions={!stepUp}
    >
      <div className="flex flex-col gap-4">
        <p>
          They lose access to this account at once.{" "}
          {mailboxes !== null && owned.length === 0
            ? "They don't have a mailbox in it."
            : one
              ? "Their mailbox and mail stay, as a shared mailbox with their sign-in turned off."
              : "Their mailboxes and mail stay, as shared mailboxes with their sign-in turned off."}
        </p>
        {offer && !stepUp && (
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-to`} className="am-h4">
              Give full access to {one ? "their mailbox" : "their mailboxes"} to
            </label>
            <select
              id={`${id}-to`}
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                if (e.target.value === "") setSendAs(false);
              }}
              className={inputClass}
            >
              <option value="">Nobody for now</option>
              {candidates.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name ? `${p.name} (${p.email})` : p.email}
                </option>
              ))}
            </select>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={sendAs}
                disabled={to === ""}
                onChange={(e) => {
                  setSendAs(e.target.checked);
                }}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span className="am-small text-foreground">Also let them send as {one ? "it" : "them"}</span>
            </label>
            <p className="am-micro">
              Read and manage for <span className="font-mono break-all">{owned.join(", ")}</span>. You can change it
              later on the mailbox&apos;s Delegation tab.
            </p>
          </div>
        )}
        {owned.length > 0 && handOver?.kind === "later" && (
          <p className="am-small">
            An owner can give someone access to {one ? "their mailbox" : "their mailboxes"} afterwards, on the
            mailbox&apos;s Delegation tab.
          </p>
        )}
        {stepUp && (
          <StepUpForm
            why="Giving someone access to a mailbox needs your console password."
            onConfirmed={async () => {
              const err = await remove();
              if (err !== null) setError(err);
            }}
            onCancel={() => {
              setStepUp(false);
              setError(null);
            }}
          />
        )}
        {stepUp && error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}
