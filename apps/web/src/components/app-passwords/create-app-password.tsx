// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, Copy, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import {
  APP_PASSWORD_DEFAULT_PROTOCOLS,
  APP_PASSWORD_NAME_MAX,
  APP_PASSWORD_PROTOCOL_LABELS,
  APP_PASSWORD_PROTOCOLS,
  type AppPasswordProtocol,
} from "@anhourmail/shared/security";

import { callApi } from "../api";
import { Checkbox } from "../console/data-list";
import { StepUpForm } from "../security/step-up-form";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";

type Created = { appPassword: { name: string }; secret: string; address: string };

/** Groups of four for reading aloud or typing on a phone; copying (button or selection) gives it without spaces. */
function Grouped({ value }: { value: string }) {
  const prefix = /^[a-z]+_/.exec(value)?.[0] ?? "";
  const rest = value.slice(prefix.length);
  const groups = rest.match(/.{1,4}/g) ?? [];
  return (
    <code className="am-code flex flex-wrap gap-x-2 gap-y-1 text-[17px] leading-7 tracking-wide">
      {prefix && <span>{prefix}</span>}
      {groups.map((g, i) => (
        <span key={`${String(i)}-${g}`}>{g}</span>
      ))}
    </code>
  );
}

/** The new app password, shown once: copy it, then it's gone from the page. */
function Reveal({ created, onDone }: { created: Created; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="flex flex-col gap-4 rounded-xl border border-primary/40 bg-primary/5 p-4">
      <div className="flex flex-col gap-1">
        <h4 className="am-h4">Your app password for {created.appPassword.name}</h4>
        <p className="am-small text-foreground">
          Copy it into your mail app now, with <span className="font-mono">{created.address}</span> as the username. You
          won&apos;t see it again: if you lose it, revoke it and make a new one.
        </p>
      </div>
      <div className="rounded-lg border bg-background px-3 py-2.5">
        <Grouped value={created.secret} />
      </div>
      <p className="am-micro">The spaces are only for reading. Type it without them.</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(created.secret).then(() => {
              setCopied(true);
            });
          }}
          className={primaryButtonClass}
        >
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copied ? "Copied" : "Copy password"}
        </button>
        <button type="button" onClick={onDone} className={secondaryButtonClass}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * "Create an app password" for one of the person's own mailboxes: a name and what it can be used for, then a recent
 * confirmation that it's them (their console password) if the server asks, then the password, shown once.
 */
export function CreateAppPassword({
  accountId,
  mailboxId,
  address,
}: {
  accountId: string;
  mailboxId: string;
  address: string;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [protocols, setProtocols] = useState<AppPasswordProtocol[]>([...APP_PASSWORD_DEFAULT_PROTOCOLS]);
  const [stepUp, setStepUp] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const url = `/api/accounts/${encodeURIComponent(accountId)}/mailboxes/${encodeURIComponent(mailboxId)}/app-passwords`;

  function reset() {
    setOpen(false);
    setName("");
    setProtocols([...APP_PASSWORD_DEFAULT_PROTOCOLS]);
    setStepUp(false);
    setError(null);
  }

  async function create() {
    setPending(true);
    setError(null);
    const res = await callApi(url, { method: "POST", body: { name, protocols } });
    setPending(false);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(true);
      else setError(res.message);
      return;
    }
    setCreated(res.data as Created);
    reset();
    // The list and the count below update while the password is still on screen.
    router.refresh();
  }

  if (created) {
    return (
      <Reveal
        created={created}
        onDone={() => {
          setCreated(null);
          router.refresh();
        }}
      />
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className={`${primaryButtonClass} w-fit`}
      >
        <Plus className="size-4" aria-hidden />
        Create app password
      </button>
    );
  }

  if (stepUp) {
    return (
      <StepUpForm
        why="An app password opens your mail, so making one needs your console password."
        confirmLabel="Confirm and create"
        onConfirmed={async () => {
          setStepUp(false);
          await create();
        }}
        onCancel={reset}
      />
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      className="flex max-w-lg flex-col gap-4 rounded-xl border p-4"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-name`} className="am-h4">
          Name <span className="am-small font-normal">(the device or app, so you can tell them apart)</span>
        </label>
        <input
          id={`${id}-name`}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          maxLength={APP_PASSWORD_NAME_MAX}
          placeholder="Phone"
          required
          autoComplete="off"
          className={inputClass}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="am-h4 mb-1">It can be used for</legend>
        {APP_PASSWORD_PROTOCOLS.map((p) => (
          <label key={p} className="flex cursor-pointer items-start gap-2.5">
            <span className="mt-0.5">
              <Checkbox
                label={APP_PASSWORD_PROTOCOL_LABELS[p].label}
                checked={protocols.includes(p)}
                onChange={(on) => {
                  setProtocols((prev) => (on ? [...prev, p] : prev.filter((x) => x !== p)));
                }}
              />
            </span>
            <span className="flex flex-col">
              <span className="text-[14px]">{APP_PASSWORD_PROTOCOL_LABELS[p].label}</span>
              <span className="am-micro">{APP_PASSWORD_PROTOCOL_LABELS[p].hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="am-small">
        For <span className="font-mono">{address}</span>. You&apos;ll see the password once, right after this.
      </p>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || protocols.length === 0} className={primaryButtonClass}>
          {pending ? "Creating…" : "Create password"}
        </button>
        <button type="button" onClick={reset} className={secondaryButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}
