// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Mailbox, ShieldOff } from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";

import { primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";

import { createMailClient, MailboxRefusedError, SignedOutError } from "./mail-client";
import { SharedMailboxSkeleton } from "./mailbox-skeleton";
import { WebmailApp } from "./webmail-app";

/**
 * The one answer for a mailbox-scoped page that can't be opened (ADR-0026 §6): no grant, an address that doesn't exist
 * or belongs to another account, or access that was taken away. It never says which, so it confirms nothing.
 */
export function MailboxRefused({ address, ownHref }: { address?: string | undefined; ownHref: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-md flex-col items-start gap-4">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <ShieldOff className="size-6" aria-hidden />
        </span>
        <h1 className="am-h1">You don't have access to this mailbox</h1>
        <p className="am-small">
          {address !== undefined && (
            <>
              <span className="break-all font-mono text-foreground">{address}</span> can't be opened with your
              sign-in.{" "}
            </>
          )}
          Check the address, or ask your account's admin to give you access. If you had access before, it may have been
          taken away.
        </p>
        <a href={ownHref} className={primaryButtonClass}>
          Go to your mailbox
        </a>
      </div>
    </main>
  );
}

type AppProps = Omit<ComponentProps<typeof WebmailApp>, "username" | "scope">;

/**
 * A tab scoped to one mailbox shared with the person (Open another mailbox, `/mailbox/<address>/`). It opens the
 * mailbox for this session without switching what the person's other tabs show (the grant checked now and the open
 * audited), then shows it with every request pinned to it. Refused — now or later — it shows `MailboxRefused`, naming
 * the address only once the server has refused it. Unless the page was reached from this origin (`autoOpen`), the
 * open waits for a click, so a link from elsewhere never opens a mailbox (or uses up the open limit) by itself.
 */
export function ScopedMailbox({
  address,
  folder,
  ownHref,
  opened,
  autoOpen,
  ...app
}: AppProps & { address: string; folder?: string | undefined; ownHref: string; opened: boolean; autoOpen: boolean }) {
  const [state, setState] = useState<"ask" | "opening" | "ready" | "refused" | "failed">(
    opened ? "ready" : autoOpen ? "opening" : "ask",
  );
  const { signInHref } = app;
  useEffect(() => {
    if (state !== "opening") return;
    let live = true;
    createMailClient()
      .openScoped(address)
      .then(() => {
        if (live) setState("ready");
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof SignedOutError) window.location.assign(signInHref);
        else setState(err instanceof MailboxRefusedError ? "refused" : "failed");
      });
    return () => {
      live = false;
    };
  }, [state, address, signInHref]);

  if (state === "ask") {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-md flex-col items-start gap-4">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Mailbox className="size-6" aria-hidden />
          </span>
          <h1 className="am-h1">Open a shared mailbox</h1>
          <p className="am-small">
            This link opens <span className="break-all font-mono text-foreground">{address}</span> with your sign-in, if
            it has been shared with you. Your other tabs stay on your own mailbox.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setState("opening");
              }}
              className={`${primaryButtonClass} max-w-full`}
            >
              Open <span className="min-w-0 truncate font-mono text-[14px]">{address}</span>
            </button>
            <a href={ownHref} className={secondaryButtonClass}>
              Go to your mailbox
            </a>
          </div>
        </div>
      </main>
    );
  }
  if (state === "opening") return <SharedMailboxSkeleton />;
  // Named only now that the server has refused it (never just because it is in the link).
  if (state === "refused") return <MailboxRefused address={address} ownHref={ownHref} />;
  if (state === "failed") {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-md flex-col items-start gap-4">
          <h1 className="am-h1">This mailbox couldn't be opened</h1>
          <p className="am-small">
            The mail server isn't answering, or you opened several mailboxes at once. Try again in a moment.
          </p>
          <button
            type="button"
            onClick={() => {
              window.location.reload();
            }}
            className={primaryButtonClass}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }
  return (
    <WebmailApp
      {...app}
      username={address}
      scope={{
        ownHref,
        folder,
        onRefused: () => {
          setState("refused");
        },
      }}
    />
  );
}
