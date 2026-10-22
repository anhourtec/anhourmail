// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { LogOut, Monitor } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { callApi } from "../api";
import { ConfirmDialog, inlineActionClass } from "../console/flyout";
import { StatusText } from "../console/status-text";
import { secondaryButtonClass } from "../ui-classes";

export type SessionRow = {
  id: string;
  device: string;
  network: string | null;
  signedIn: string;
  lastActive: string;
  current: boolean;
};

function SessionItem({ s }: { s: SessionRow }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <li className="flex flex-col gap-1 border-b px-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 text-[14px] font-medium">
            {s.device}
            {s.current && <StatusText tone="success">This browser</StatusText>}
          </span>
          <span className="am-micro">
            Signed in {s.signedIn} · last active {s.lastActive}
            {s.network && (
              <>
                {" · "}
                <span className="font-mono">{s.network}</span>
              </>
            )}
          </span>
          {error && (
            <span role="alert" className="am-small text-destructive">
              {error}
            </span>
          )}
        </div>
      </div>
      {!s.current && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError(null);
            void callApi(`/api/me/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" }).then((res) => {
              setPending(false);
              if (!res.ok) setError(res.message);
              else router.refresh();
            });
          }}
          className={`${inlineActionClass} shrink-0 self-start sm:self-center`}
        >
          <LogOut className="size-3.5" aria-hidden />
          {pending ? "Signing out…" : "Sign out"}
          <span className="sr-only"> {s.device}</span>
        </button>
      )}
    </li>
  );
}

/** Where the person is signed in to the console, with "sign out this session" and "sign out everywhere else". */
export function SessionList({ sessions, hasPasskeys }: { sessions: SessionRow[]; hasPasskeys: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [removePasskeys, setRemovePasskeys] = useState(false);
  const others = sessions.filter((s) => !s.current).length;
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Signed-in sessions" className="border-t">
        {sessions.map((s) => (
          <SessionItem key={s.id} s={s} />
        ))}
      </ul>
      <div>
        <button
          type="button"
          onClick={() => {
            setConfirm(true);
          }}
          className={secondaryButtonClass}
        >
          <LogOut className="size-4" aria-hidden />
          Sign out everywhere else
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          title="Sign out everywhere else?"
          confirmLabel="Sign out everywhere else"
          pendingLabel="Signing out…"
          onCancel={() => {
            setConfirm(false);
          }}
          onConfirm={async () => {
            const res = await callApi("/api/me/sessions", {
              method: "DELETE",
              ...(removePasskeys ? { body: { removePasskeys: true } } : {}),
            });
            if (!res.ok) return res.message;
            setConfirm(false);
            router.refresh();
            return null;
          }}
        >
          {others === 0
            ? "You're only signed in here. "
            : `This ends ${String(others)} other ${others === 1 ? "session" : "sessions"}. `}
          Trusted browsers will ask for your second step again. This browser stays signed in.
          {hasPasskeys && (
            <label className="mt-3 flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={removePasskeys}
                onChange={(e) => {
                  setRemovePasskeys(e.target.checked);
                }}
                className="mt-1 size-4 accent-primary"
              />
              <span className="am-small text-foreground">
                Also remove all my passkeys (they sign in on their own; add them again afterwards)
              </span>
            </label>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
