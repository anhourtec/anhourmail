// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Plus, UserMinus } from "lucide-react";
import { useId, useState } from "react";

import {
  DELEGATION_RIGHT_LABELS,
  DELEGATION_RIGHTS,
  type DelegationRight,
  type DelegationUpdate,
} from "@anhourmail/shared/delegation";

import { Avatar } from "../account-menu";
import { callApi } from "../api";
import { StepUpForm } from "../security/step-up-form";
import { primaryButtonClass, secondaryButtonClass } from "../ui-classes";

/** A person on one of the lists, or one who can be added. */
export type DelegatePerson = { userId: string; name: string; email: string };

/** The three lists as `GET`/`PATCH …/delegation` answer them. */
export type DelegationLists = {
  fullAccess: DelegatePerson[];
  sendAs: DelegatePerson[];
  sendOnBehalf: DelegatePerson[];
};

const LIST_OF: Record<DelegationRight, keyof DelegationLists> = {
  full_access: "fullAccess",
  send_as: "sendAs",
  send_on_behalf: "sendOnBehalf",
};

/** What each right allows, under its heading. */
const RIGHT_HELP: Record<DelegationRight, string> = {
  full_access: "Open this mailbox and read, move and delete mail in all its folders. This doesn't include sending.",
  send_as: "Send mail from this mailbox's address. Recipients see only the mailbox, not who sent it.",
  send_on_behalf: "Send mail from this mailbox that also names who sent it, as “Name on behalf of the mailbox”.",
};

/** Why the lists are read-only here, when they are. */
export type DelegationReadOnly =
  { kind: "plan"; planName: string } | { kind: "role" } | { kind: "locked" } | { kind: "deleting" } | null;

const smallButton =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[14px] text-primary transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60 [&>svg]:size-4";

/**
 * A mailbox's Delegation tab (ADR-0026 §5): three separate lists — Read and manage, Send as, Send on behalf — each with
 * its people, a Remove button per person and Add people (a picker of the account's people, never the mailbox's own
 * person). A change is one `PATCH …/delegation` batch; the server asks for a fresh confirmation that it's you (403
 * `step_up_required`) and the batch is sent again once confirmed. Read-only with only `delegation.read`, on a plan
 * without delegation, on an Owner's or admin's mailbox for a User Administrator (guard rail 8) and while the mailbox is
 * being deleted; the server checks all of it again.
 */
export function DelegationTab({
  accountId,
  mailboxId,
  address,
  initial,
  candidates,
  photos,
  readOnly,
}: {
  accountId: string;
  mailboxId: string;
  address: string;
  initial: DelegationLists;
  /** People who may be added (the account's people, without the mailbox's own person). Empty when read-only. */
  candidates: DelegatePerson[];
  /** Profile photo URLs by person id (versioned, this origin). */
  photos: Record<string, string>;
  readOnly: DelegationReadOnly;
}) {
  const id = useId();
  const [lists, setLists] = useState<DelegationLists>(initial);
  const [adding, setAdding] = useState<DelegationRight | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ right: DelegationRight; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<{ right: DelegationRight; batch: DelegationUpdate; done: string } | null>(null);
  const url = `/api/accounts/${encodeURIComponent(accountId)}/mailboxes/${encodeURIComponent(mailboxId)}/delegation`;
  const canChange = readOnly === null;
  // After a downgrade the lists can't grow, but taking access away still works (the server allows it on any plan).
  const canRemove = readOnly === null || readOnly.kind === "plan";

  async function apply(right: DelegationRight, batch: DelegationUpdate, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await callApi(url, { method: "PATCH", body: batch });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp({ right, batch, done });
      else {
        setStepUp(null);
        setError({ right, text: res.message });
      }
      return;
    }
    const next = res.data as Partial<DelegationLists> | undefined;
    setLists({
      fullAccess: next?.fullAccess ?? [],
      sendAs: next?.sendAs ?? [],
      sendOnBehalf: next?.sendOnBehalf ?? [],
    });
    setStepUp(null);
    setAdding(null);
    setChosen([]);
    setNotice(done);
  }

  const nameOf = (p: DelegatePerson) => p.name || p.email;

  return (
    <div className="flex flex-col gap-8">
      <p className="am-body max-w-prose">
        Give people in this account access to <span className="font-mono break-all">{address}</span>. The three lists
        are separate: Read and manage doesn&apos;t include sending, and the send rights work without it. People with
        Read and manage find the mailbox in their webmail under Shared with you; the send rights add it to From there.
        If someone has both Send as and Send on behalf, Send as is used. Changes can take up to a minute to apply.
      </p>
      {readOnly && (
        <p className="am-small max-w-prose rounded-lg border px-4 py-3">
          {readOnly.kind === "plan"
            ? `The ${readOnly.planName} plan doesn't include giving people access to other mailboxes. Upgrade to Plus to use delegation. You can still remove the access people have.`
            : readOnly.kind === "locked"
              ? "This mailbox belongs to an owner or an admin, so only an owner can change who has access to it."
              : readOnly.kind === "deleting"
                ? "This mailbox is being deleted, so who has access to it can't change. Restore it first."
                : "Only an owner or a user administrator can change who has access to a mailbox."}
        </p>
      )}
      <p role="status" aria-live="polite" className="am-small empty:hidden">
        {notice}
      </p>

      {DELEGATION_RIGHTS.map((right) => {
        const label = DELEGATION_RIGHT_LABELS[right];
        const people = lists[LIST_OF[right]];
        const onList = new Set(people.map((p) => p.userId));
        const addable = candidates.filter((p) => !onList.has(p.userId));
        const headingId = `${id}-${right}`;
        return (
          <section key={right} aria-labelledby={headingId} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex max-w-prose flex-col gap-1">
                <h3 id={headingId} className="am-h4">
                  {label}
                </h3>
                <p className="am-small">{RIGHT_HELP[right]}</p>
              </div>
              {canChange && adding !== right && (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Add people to ${label}`}
                  onClick={() => {
                    setAdding(right);
                    setChosen([]);
                    setError(null);
                    setStepUp(null);
                    setNotice(null);
                  }}
                  className={`${secondaryButtonClass} h-9`}
                >
                  <Plus className="size-4" aria-hidden />
                  Add people
                </button>
              )}
            </div>

            {people.length === 0 ? (
              <p className="am-small border-y py-3 text-muted-foreground">Nobody has this yet.</p>
            ) : (
              <ul aria-labelledby={headingId} className="flex flex-col divide-y border-y">
                {people.map((p) => (
                  <li key={p.userId} className="flex items-center gap-3 py-2.5">
                    <Avatar name={p.name} email={p.email} photoUrl={photos[p.userId] ?? null} size="sm" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[14px] font-medium">{nameOf(p)}</span>
                      <span className="font-mono text-[12.5px] break-all text-muted-foreground">{p.email}</span>
                    </div>
                    {canRemove && (
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Remove ${nameOf(p)} from ${label}`}
                        onClick={() => {
                          setAdding(null);
                          void apply(
                            right,
                            { add: [], remove: [{ userId: p.userId, right }] },
                            `Removed ${nameOf(p)} from ${label}.`,
                          );
                        }}
                        className={smallButton}
                      >
                        <UserMinus aria-hidden />
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {canChange && adding === right && stepUp?.right !== right && (
              <fieldset className="flex flex-col gap-3 rounded-xl border p-4">
                <legend className="am-h4 px-1">Add people to {label}</legend>
                {addable.length === 0 ? (
                  <p className="am-small">Everyone in this account who can be added is on this list already.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {addable.map((p) => {
                      const boxId = `${id}-${right}-${p.userId}`;
                      return (
                        <li key={p.userId}>
                          <label
                            htmlFor={boxId}
                            className="flex cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 hover:bg-accent"
                          >
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
                            <Avatar name={p.name} email={p.email} photoUrl={photos[p.userId] ?? null} size="sm" />
                            <span className="flex min-w-0 flex-col">
                              <span className="text-[14px]">{nameOf(p)}</span>
                              <span className="font-mono text-[12.5px] break-all text-muted-foreground">{p.email}</span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="flex flex-wrap gap-2">
                  {addable.length > 0 && (
                    <button
                      type="button"
                      disabled={busy || chosen.length === 0}
                      onClick={() => {
                        const n = chosen.length;
                        void apply(
                          right,
                          { add: chosen.map((userId) => ({ userId, right })), remove: [] },
                          `Added ${n === 1 ? "1 person" : `${String(n)} people`} to ${label}.`,
                        );
                      }}
                      className={primaryButtonClass}
                    >
                      {busy ? "Adding…" : "Add"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(null);
                      setChosen([]);
                      setError(null);
                    }}
                    className={secondaryButtonClass}
                  >
                    Cancel
                  </button>
                </div>
              </fieldset>
            )}

            {stepUp?.right === right && (
              <StepUpForm
                why="Giving or taking away access to a mailbox needs your console password or a code from the last few minutes."
                onConfirmed={() => apply(right, stepUp.batch, stepUp.done)}
                onCancel={() => {
                  setStepUp(null);
                }}
              />
            )}
            {error?.right === right && (
              <p role="alert" className="am-small text-destructive">
                {error.text}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
