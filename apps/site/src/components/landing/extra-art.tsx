// SPDX-License-Identifier: AGPL-3.0-only
/**
 * More decorative illustrations for the feature pages. Facts come from @anhourmail/shared; hidden from
 * assistive tech (the surrounding text carries the meaning).
 */
import type { CSSProperties } from "react";

import { KeyRoundIcon, LockIcon, RefreshCwIcon } from "lucide-react";

import { CLIENT_ENDPOINTS, DKIM_SELECTORS, dkimTarget, PUBLIC_PLATFORM } from "@anhourmail/shared";

export function DkimRotation() {
  return (
    <div aria-hidden="true" className="am-site-panel overflow-hidden">
      <div className="flex items-center justify-between border-b px-5 py-3.5">
        <span className="flex items-center gap-2 font-medium text-sm">
          <KeyRoundIcon className="size-4 text-[rgb(var(--am-btn))]" />
          Signing keys
        </span>
        <span className="am-site-chip am-site-chip--success">
          <RefreshCwIcon className="am-site-spin size-3" />
          Rotating automatically
        </span>
      </div>
      <ul className="divide-y">
        {DKIM_SELECTORS.map((sel, i) => (
          <li
            key={sel}
            className="am-site-instant grid grid-cols-[minmax(0,1fr)] gap-1 px-5 py-3.5"
            style={{ "--i": i } as CSSProperties}
          >
            <span className="font-mono text-[12.5px]">{sel}._domainkey.yourname.com</span>
            <span className="truncate font-mono text-[11.5px] text-muted-foreground">
              → {dkimTarget(sel, "yourname.com", PUBLIC_PLATFORM)}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t px-5 py-3 text-[12px] text-muted-foreground">
        You publish these once. New keys need no DNS changes.
      </p>
    </div>
  );
}

export function SettingsCard() {
  const rows = CLIENT_ENDPOINTS;
  return (
    <div aria-hidden="true" className="am-site-frame">
      <div className="am-site-frame-bar">
        <span className="flex gap-1.5">
          <span className="am-site-frame-dot" />
          <span className="am-site-frame-dot" />
          <span className="am-site-frame-dot" />
        </span>
        <span className="am-site-frame-url">
          <LockIcon className="size-3" />
          Account settings
        </span>
        <span className="w-[42px]" />
      </div>
      <ul className="divide-y text-left">
        {rows.map((e, i) => (
          <li
            key={`${e.protocol}-${e.port}`}
            className="am-site-instant grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3"
            style={{ "--i": i } as CSSProperties}
          >
            <span className="am-code rounded-md bg-muted px-1.5 py-0.5 text-center text-[11px]">{e.protocol}</span>
            <span className="truncate font-mono text-[12.5px]">
              {e.host}:{e.port}
            </span>
            <span className={`am-site-chip ${e.recommended ? "am-site-chip--success" : ""}`}>{e.security}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
