// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { X } from "lucide-react";
import { type ReactNode, type SyntheticEvent, useState } from "react";

import { PasswordInput } from "@/components/password-input";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";
import { useHydrated } from "@/components/use-hydrated";

import { type MailClient, RefusedError } from "./mail-client";
import { mailboxTabHref, pagesBase } from "./tab-paths";

/** A centred modal with a title, closed by Escape, the backdrop or the X. */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
  size,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** "lg" for content with a preview (e.g. Insert HTML). */
  size?: "lg";
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
        className={`relative w-full rounded-2xl border bg-popover p-5 shadow-2xl ${size === "lg" ? "max-w-2xl" : wide ? "max-w-md" : "max-w-sm"}`}
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

/**
 * "Open another mailbox" (ADR-0026 §6): the address of a mailbox shared with the person, opened in a new tab at its own
 * address-scoped page. That tab checks access (and says when there is none); this tab stays as it is.
 */
export function OpenMailboxDialog({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const hydrated = useHydrated();

  function submit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = new FormData(e.currentTarget).get("address");
    const address = typeof v === "string" ? v.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setError("Enter a mailbox address, like name@example.com.");
      return;
    }
    window.open(mailboxTabHref(pagesBase(), address), "_blank", "noopener");
    onClose();
  }

  return (
    <Modal title="Open another mailbox" onClose={onClose} wide>
      <form method="post" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <p className="am-small -mt-1">
          Open a mailbox someone gave you access to. It opens in a new tab; this one stays on your mailbox.
        </p>
        <label className="flex flex-col gap-1.5">
          <span className="am-h4">Mailbox address</span>
          <input
            name="address"
            type="email"
            autoComplete="off"
            required
            autoFocus
            aria-invalid={error !== null}
            className={`${inputClass} font-mono text-[14px]`}
          />
        </label>
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
        <button type="submit" disabled={!hydrated} className={primaryButtonClass}>
          Open
        </button>
      </form>
    </Modal>
  );
}

/**
 * Settings while a mailbox shared with the person is shown: they belong to the person's own mailbox (ADR-0026 §6), so
 * this says so and offers the way back.
 */
export function OwnSettingsDialog({
  address,
  onBack,
  backHref,
  onClose,
}: {
  address: string;
  onBack?: (() => void) | undefined;
  backHref?: string | undefined;
  onClose: () => void;
}) {
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <p className="am-small mb-5">
        Settings, signatures, contacts and sending belong to your own mailbox. You're viewing{" "}
        <span className="font-mono text-foreground">{address}</span>, a mailbox shared with you. Go back to your mailbox
        to change them.
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" autoFocus onClick={onClose} className={secondaryButtonClass}>
          Close
        </button>
        {backHref ? (
          <a href={backHref} className={primaryButtonClass}>
            Go to your mailbox
          </a>
        ) : (
          <button type="button" onClick={onBack} className={primaryButtonClass}>
            Back to your mailbox
          </button>
        )}
      </div>
    </Modal>
  );
}
