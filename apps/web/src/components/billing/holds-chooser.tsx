// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { PLANS } from "@anhourmail/shared/plans";

import { callApi } from "../api";
import { secondaryButtonClass } from "../ui-classes";

type Choices = {
  mailboxes: { id: string; address: string; kept: boolean }[];
  aliases: { id: string; address: string; kind: "alias" | "masked"; mailboxId: string; kept: boolean }[];
};

/**
 * "Choose what stays on" after the paid plan ended (ADR-0029 §6): Free keeps one mailbox on the platform domain and,
 * on it, up to Free's number of aliases and masked aliases. Everything else is held — never deleted: held mailboxes
 * keep sign-in, reading and export. Saving swaps what's held; receive windows already running keep their dates.
 */
export function HoldsChooser({ accountId, choices }: { accountId: string; choices: Choices }) {
  const id = useId();
  const router = useRouter();
  const free = PLANS.free;
  const [mailboxId, setMailboxId] = useState(choices.mailboxes.find((m) => m.kept)?.id ?? choices.mailboxes[0]?.id);
  const [aliasIds, setAliasIds] = useState<Set<string>>(
    () => new Set(choices.aliases.filter((a) => a.kept).map((a) => a.id)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const onMailbox = choices.aliases.filter((a) => a.mailboxId === mailboxId);
  const count = (kind: "alias" | "masked") => onMailbox.filter((a) => a.kind === kind && aliasIds.has(a.id)).length;
  const over =
    (free.aliases !== null && count("alias") > free.aliases) ||
    (free.maskedAliases !== null && count("masked") > free.maskedAliases);

  async function save() {
    if (!mailboxId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await callApi(`/api/accounts/${accountId}/billing/holds`, {
      method: "PUT",
      body: { mailboxId, aliasIds: onMailbox.filter((a) => aliasIds.has(a.id)).map((a) => a.id) },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setMessage("Saved. The mail server follows within a minute.");
    router.refresh();
  }

  if (choices.mailboxes.length === 0) {
    return (
      <p className="am-small max-w-prose">
        This account has no mailbox on the platform domain, so everything is held. An Owner can claim a free address on
        the Mailboxes page and keep it.
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="am-h4 mb-1">Mailbox that stays on</legend>
        {choices.mailboxes.map((m) => (
          <label key={m.id} className="flex items-center gap-2 text-[15px]">
            <input
              type="radio"
              name={`${id}-mailbox`}
              checked={mailboxId === m.id}
              onChange={() => {
                setMailboxId(m.id);
                setAliasIds(new Set());
                setMessage(null);
              }}
              className="accent-[rgb(var(--primary))]"
            />
            <span className="font-mono break-all">{m.address}</span>
          </label>
        ))}
      </fieldset>
      {onMailbox.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="am-h4 mb-1">Aliases that stay on</legend>
          <p className="am-micro">
            Up to {free.aliases} aliases and {free.maskedAliases} masked aliases. The rest are held, not deleted.
          </p>
          {onMailbox.map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-[15px]">
              <input
                type="checkbox"
                checked={aliasIds.has(a.id)}
                onChange={(e) => {
                  const next = new Set(aliasIds);
                  if (e.target.checked) next.add(a.id);
                  else next.delete(a.id);
                  setAliasIds(next);
                  setMessage(null);
                }}
                className="accent-[rgb(var(--primary))]"
              />
              <span className="font-mono break-all">{a.address}</span>
              {a.kind === "masked" && <span className="am-micro">masked</span>}
            </label>
          ))}
        </fieldset>
      )}
      {over && (
        <p role="alert" className="am-small text-destructive">
          {`Free keeps up to ${String(free.aliases)} aliases and ${String(free.maskedAliases)} masked aliases on.`}
        </p>
      )}
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="am-small">
          {message}
        </p>
      )}
      <button type="submit" disabled={busy || over || !mailboxId} className={`${secondaryButtonClass} w-fit`}>
        {busy ? "Saving…" : "Save what stays on"}
      </button>
    </form>
  );
}
