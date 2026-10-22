// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { X } from "lucide-react";
import { type ReactNode, type SyntheticEvent, useState } from "react";

import { PasswordInput } from "@/components/password-input";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";
import { useHydrated } from "@/components/use-hydrated";

import { type MailClient, RefusedError } from "./mail-client";

/** A centred modal with a title, closed by Escape, the backdrop or the X. */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center p-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-foreground/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full rounded-2xl border bg-popover p-5 shadow-2xl ${wide ? "max-w-md" : "max-w-sm"}`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="am-h3">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** "Delete forever?" and "Empty Trash?": the destructive button is the only primary one. */
export function ConfirmDialog({
  title,
  body,
  confirm,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="am-small mb-5">{body}</p>
      <div className="flex justify-end gap-2">
        <button type="button" autoFocus onClick={onClose} className={secondaryButtonClass}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            onConfirm();
            onClose();
          }}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-destructive px-4 font-medium text-[15px] text-background transition-opacity hover:opacity-90"
        >
          {confirm}
        </button>
      </div>
    </Modal>
  );
}

/** "Add another mailbox": its address and password, signed in to this webmail session (never stored). */
export function AddMailboxDialog({ client, onClose }: { client: MailClient; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const hydrated = useHydrated();

  async function submit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const field = (k: string) => {
        const v = form.get(k);
        return typeof v === "string" ? v : "";
      };
      await client.addMailbox(field("address"), field("password"));
      window.location.reload();
    } catch (err) {
      setError(err instanceof RefusedError ? err.message : "Couldn't add that mailbox. Try again.");
      setPending(false);
    }
  }

  return (
    <Modal title="Add another mailbox" onClose={onClose} wide>
      <form
        method="post"
        onSubmit={(e) => {
          void submit(e);
        }}
        className="flex flex-col gap-4"
        noValidate
      >
        <p className="am-small -mt-1">
          Sign in to another mailbox you use. You can switch between them from the top of the sidebar.
        </p>
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">Mailbox address</span>
          <input
            name="address"
            type="email"
            autoComplete="username"
            required
            autoFocus
            className={`${inputClass} font-mono text-[14px]`}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="add-mailbox-password" className="am-h4">
            Password
          </label>
          <PasswordInput
            id="add-mailbox-password"
            name="password"
            autoComplete="current-password"
            required
            className={inputClass}
          />
        </div>
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending || !hydrated} className={primaryButtonClass}>
          {pending ? "Signing in…" : "Add mailbox"}
        </button>
      </form>
    </Modal>
  );
}
