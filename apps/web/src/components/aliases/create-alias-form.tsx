// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Plus, Shuffle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { callApi } from "../api";
import { CopyValue } from "../copy-value";
import { inputClass, primaryButtonClass } from "../ui-classes";

type Options = {
  mailboxes: { id: string; address: string }[];
  domains: { id: string; name: string }[];
  /** Which kinds still have room on the plan. */
  room: { alias: boolean; masked: boolean };
};

const kindButton =
  "h-8 rounded-md px-3 text-[14px] text-muted-foreground transition-colors aria-checked:bg-accent aria-checked:text-foreground hover:text-foreground disabled:opacity-50";

/**
 * New alias: either an address you choose on one of the account's domains, or a masked one (random, on the
 * mailbox's domain) to hand to a single site. The new masked address is shown with a copy button.
 */
export function CreateAliasForm({ accountId, options }: { accountId: string; options: Options }) {
  const router = useRouter();
  const chosenOk = options.room.alias && options.domains.length > 0;
  const [kind, setKind] = useState<"alias" | "masked">(chosenOk ? "alias" : "masked");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const field = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    const body: Record<string, string> = { kind, mailboxId: field("mailboxId"), description: field("description") };
    if (kind === "alias") Object.assign(body, { localPart: field("localPart"), domainId: field("domainId") });
    void create(body, e.currentTarget);
  }

  async function create(body: Record<string, string>, form: HTMLFormElement) {
    setPending(true);
    setError(null);
    setCreated(null);
    const res = await callApi(`/api/accounts/${accountId}/aliases`, { method: "POST", body });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const address = (res.data as { address?: unknown } | undefined)?.address;
    if (typeof address === "string") setCreated(address);
    form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-xl border p-4 sm:p-5" noValidate>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="am-h3">New alias</h2>
        <div role="radiogroup" aria-label="Kind of alias" className="flex rounded-lg border p-0.5">
          <button
            type="button"
            role="radio"
            aria-checked={kind === "alias"}
            disabled={!chosenOk}
            onClick={() => {
              setKind("alias");
            }}
            className={kindButton}
          >
            Choose an address
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={kind === "masked"}
            disabled={!options.room.masked}
            onClick={() => {
              setKind("masked");
            }}
            className={kindButton}
          >
            Masked
          </button>
        </div>
      </div>

      {kind === "alias" ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="alias-local" className="am-h4">
            Address
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              id="alias-local"
              name="localPart"
              placeholder="hello"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              className={`${inputClass} font-mono sm:max-w-56`}
            />
            <span aria-hidden className="am-code hidden sm:inline">
              @
            </span>
            <label htmlFor="alias-domain" className="sr-only">
              Domain
            </label>
            <select id="alias-domain" name="domainId" className={`${inputClass} font-mono sm:max-w-64`}>
              {options.domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        <p className="am-small">
          A random address on the mailbox's domain. Give it to one site; if it starts getting spam, turn it off.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">Delivers to</span>
          <select name="mailboxId" className={`${inputClass} font-mono`}>
            {options.mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.address}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">
            Note <span className="am-micro font-normal">(optional, only you see it)</span>
          </span>
          <input
            name="description"
            maxLength={100}
            placeholder={kind === "masked" ? "shop.example" : "Newsletters"}
            autoComplete="off"
            className={inputClass}
          />
        </label>
      </div>

      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      {created && (
        <div role="status" className="flex flex-col gap-1 rounded-lg border bg-muted/40 px-3 py-2.5">
          <span className="am-micro">Created. It starts working in a few seconds.</span>
          <CopyValue value={created} label="new alias" />
        </div>
      )}
      <button type="submit" disabled={pending} className={`${primaryButtonClass} w-fit`}>
        {kind === "masked" ? <Shuffle className="size-4" aria-hidden /> : <Plus className="size-4" aria-hidden />}
        {pending ? "Creating…" : kind === "masked" ? "Create masked alias" : "Create alias"}
      </button>
    </form>
  );
}
