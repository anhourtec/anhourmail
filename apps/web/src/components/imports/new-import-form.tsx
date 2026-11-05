// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import type { ImportTarget } from "@anhourmail/core/imports";
import type { ImportSourcePreset } from "@anhourmail/shared/import";

import { callApi } from "../api";
import { Checkbox } from "../console/data-list";
import { StepUpForm } from "../security/step-up-form";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";

type Preset = ImportSourcePreset & { docsUrl: string };

const UNAVAILABLE: Record<NonNullable<ImportTarget["unavailable"]>, string> = {
  mailbox_unavailable: "can't take an import now",
  import_running: "already importing",
};

function Option({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <span className="mt-0.5">
        <Checkbox label={label} checked={checked} onChange={onChange} />
      </span>
      <span className="flex flex-col">
        <span className="text-[14px]">{label}</span>
        <span className="am-micro">{hint}</span>
      </span>
    </label>
  );
}

/**
 * The "New import" form (ADR-0030 §17). The app password is write-only: it goes to the server once, is sealed there
 * and never comes back. A recent confirmation that it's the person (their console password) is asked in place when
 * the server wants one, then the start runs again; on success the import's own page opens.
 */
export function NewImportForm({
  accountId,
  targets,
  presets,
  maxMessageMb,
  syncWindowDays,
}: {
  accountId: string;
  targets: ImportTarget[];
  presets: Preset[];
  maxMessageMb: number;
  syncWindowDays: number;
}) {
  const router = useRouter();
  const id = useId();
  const firstFree = targets.find((t) => t.unavailable === null) ?? targets[0];
  const [mailboxId, setMailboxId] = useState(firstFree?.mailboxId ?? "");
  const [presetId, setPresetId] = useState(presets[0]?.id ?? "other");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<993 | 143>(993);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [excludeJunkTrash, setExcludeJunkTrash] = useState(true);
  const [intoSubfolder, setIntoSubfolder] = useState(false);
  const [sync, setSync] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/accounts/${encodeURIComponent(accountId)}/import`;
  const preset = presets.find((p) => p.id === presetId) ?? presets[presets.length - 1];
  const target = targets.find((t) => t.mailboxId === mailboxId);
  const typedHost = preset?.host === null;
  // No mailbox picked (undefined) or one that can't take an import now.
  const cantStart = target?.unavailable !== null;

  async function start() {
    setPending(true);
    setError(null);
    const res = await callApi(`/api/accounts/${encodeURIComponent(accountId)}/imports`, {
      method: "POST",
      body: {
        mailboxId,
        host: typedHost ? host.trim() : (preset?.host ?? ""),
        port: typedHost ? port : (preset?.port ?? 993),
        username: username.trim(),
        password,
        options: { excludeJunkTrash, intoSubfolder, sync },
      },
    });
    if (!res.ok) {
      setPending(false);
      if (res.code === "step_up_required") setStepUp(true);
      else setError(res.message);
      return;
    }
    setPassword("");
    const started = res.data as { id: string };
    router.push(`${base}/${encodeURIComponent(started.id)}`);
  }

  if (stepUp) {
    return (
      <div className="max-w-xl">
        <StepUpForm
          why="An import signs in to your mailbox here on your behalf, so starting one needs your console password."
          confirmLabel="Confirm and start"
          onConfirmed={async () => {
            setStepUp(false);
            await start();
          }}
          onCancel={() => {
            setStepUp(false);
          }}
        />
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
      className="flex max-w-xl flex-col gap-6"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-mailbox`} className="am-h4">
          Import into
        </label>
        <select
          id={`${id}-mailbox`}
          value={mailboxId}
          onChange={(e) => {
            setMailboxId(e.target.value);
          }}
          className={`${inputClass} font-mono`}
        >
          {targets.map((t) => (
            <option key={t.mailboxId} value={t.mailboxId} disabled={t.unavailable !== null}>
              {t.address}
              {t.unavailable
                ? ` (${UNAVAILABLE[t.unavailable]})`
                : t.as === "admin"
                  ? t.hasPerson
                    ? " (someone else's)"
                    : " (shared)"
                  : ""}
            </option>
          ))}
        </select>
        {target?.as === "admin" && (
          <p className="am-small">
            {target.hasPerson
              ? "This mailbox isn't yours: its person gets an email saying you started an import into it, and can see it here."
              : "A shared mailbox: admins who can import see this import here."}
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-4 rounded-xl border p-4">
        <legend className="am-h4 px-1">Old provider</legend>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-preset`} className="text-[14px] font-medium">
            Provider
          </label>
          <select
            id={`${id}-preset`}
            value={presetId}
            onChange={(e) => {
              setPresetId(e.target.value);
            }}
            className={inputClass}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {typedHost ? (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-host`} className="text-[14px] font-medium">
                IMAP server
              </label>
              <input
                id={`${id}-host`}
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                }}
                placeholder="imap.example.com"
                required
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                className={`${inputClass} font-mono`}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-port`} className="text-[14px] font-medium">
                Port
              </label>
              <select
                id={`${id}-port`}
                value={port}
                onChange={(e) => {
                  setPort(e.target.value === "143" ? 143 : 993);
                }}
                className={`${inputClass} font-mono sm:w-52`}
              >
                <option value={993}>993 (TLS)</option>
                <option value={143}>143 (STARTTLS)</option>
              </select>
            </div>
          </div>
        ) : (
          <p className="am-small">
            Server <span className="font-mono text-foreground">{preset?.host}</span> port{" "}
            <span className="font-mono text-foreground">{preset?.port}</span>, encrypted.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-user`} className="text-[14px] font-medium">
            User name
          </label>
          <input
            id={`${id}-user`}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
            required
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            className={`${inputClass} font-mono`}
            aria-describedby={`${id}-user-hint`}
          />
          <span id={`${id}-user-hint`} className="am-micro">
            {preset?.usernameHint}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-pass`} className="text-[14px] font-medium">
            App password
          </label>
          <input
            id={`${id}-pass`}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            required
            autoComplete="off"
            className={`${inputClass} font-mono`}
            aria-describedby={`${id}-pass-hint`}
          />
          <span id={`${id}-pass-hint`} className="am-micro">
            Make one at the old provider just for this; your usual password usually won&apos;t work. We keep it
            encrypted until the import ends, then delete it.{" "}
            {preset && (
              <a
                href={preset.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
              >
                How to make one
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </span>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="am-h4 mb-1">Options</legend>
        <Option
          label="Leave out Junk and Deleted items"
          hint="Recommended. If you copy Junk, it arrives as an ordinary folder named Imported Junk."
          checked={excludeJunkTrash}
          onChange={setExcludeJunkTrash}
        />
        <Option
          label="Put the old folders under Imported"
          hint="Inbox, Sent and Drafts still go to their usual places."
          checked={intoSubfolder}
          onChange={setIntoSubfolder}
        />
        <Option
          label="Keep copying new mail until I stop it"
          hint={`For switching over: new mail at the old provider keeps arriving here for up to ${String(syncWindowDays)} days.`}
          checked={sync}
          onChange={setSync}
        />
      </fieldset>

      <p className="am-small">
        Messages over {String(maxMessageMb)} MB stay at the old provider. Mail already in the mailbox isn&apos;t copied
        twice.
      </p>
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || cantStart} className={primaryButtonClass}>
          {pending ? "Starting…" : "Start import"}
        </button>
        <a href={base} className={secondaryButtonClass}>
          Cancel
        </a>
      </div>
    </form>
  );
}
