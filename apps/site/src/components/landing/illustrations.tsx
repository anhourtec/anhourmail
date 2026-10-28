// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Small animated illustrations for the feature rows, drawn after the real webmail and console (apps/web).
 * Animations start when the surrounding <Reveal> sets data-revealed, and stop under prefers-reduced-motion
 * (site.css). Decorative: hidden from assistive tech; each row's heading and text carry the meaning.
 */
import type { CSSProperties } from "react";

import {
  EllipsisVerticalIcon,
  ImageOffIcon,
  ListChecksIcon,
  Loader2Icon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";

import { customerDomainRecords, PUBLIC_PLATFORM } from "@anhourmail/shared";

import { ALIASES } from "./console-mock";
import {
  DEMO_DKIM_KEYS,
  DEMO_DOMAIN,
  DEMO_ME,
  MockAvatar,
  MockCheckbox,
  MockStatus,
  MockSwitch,
  stagger,
} from "./mock-parts";
import { INBOX, ListHeader, MessageRow } from "./webmail-mock";

/** The console's domain panel on its DNS records tab: each required record ticks to "Found" in turn. */
export function DnsChecks() {
  const records = customerDomainRecords(DEMO_DOMAIN, "demo", PUBLIC_PLATFORM, DEMO_DKIM_KEYS).filter((r) => r.required);
  return (
    <div aria-hidden="true" className="am-site-panel select-none overflow-hidden text-left">
      <div className="flex items-center gap-3.5 px-5 pt-5">
        <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-primary font-medium text-[16px] text-primary-foreground">
          YN
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-mono text-[15px]">{DEMO_DOMAIN}</span>
          <MockStatus tone="warning">Waiting for DNS</MockStatus>
        </span>
      </div>
      <div className="flex gap-4 px-5 pt-3 text-[12px] text-primary">
        <span className="flex items-center gap-1.5">
          <RefreshCwIcon className="am-site-spin size-3.5" />
          Checking…
        </span>
        <span className="flex items-center gap-1.5">
          <ListChecksIcon className="size-3.5" />
          DNS records
        </span>
      </div>
      <div className="mt-3 flex gap-5 border-b px-5 text-[12px] text-muted-foreground">
        <span className="pb-2">Overview</span>
        <span className="border-b-2 border-foreground pb-2 font-medium text-foreground">DNS records</span>
      </div>
      <ul className="divide-y">
        {records.map((r, i) => (
          <li
            key={`${r.type}-${r.name}`}
            className="am-site-dns-row grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-2.5"
            style={stagger(i)}
          >
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-center font-mono text-[10.5px]">{r.type}</span>
            <span className="min-w-0">
              <span className="block truncate font-mono text-[12px]">
                {r.name === "@" ? DEMO_DOMAIN : `${r.name}.${DEMO_DOMAIN}`}
              </span>
              <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{r.value}</span>
            </span>
            <span className="grid min-w-[64px] grid-cols-[minmax(0,1fr)] justify-items-start">
              <Loader2Icon className="am-site-dns-wait am-site-spin size-3.5 text-muted-foreground" />
              <MockStatus tone="success" className="am-site-dns-ok">
                Found
              </MockStatus>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The console's aliases list as a card: address and note, ⋮ menu, and the receiving switch (one flips off and on). */
export function AliasToggles() {
  return (
    <div aria-hidden="true" className="am-site-panel select-none overflow-hidden text-left">
      <div className="flex items-center gap-3 border-b px-5 py-2.5 font-medium text-[11.5px]">
        <MockCheckbox />
        <span className="flex-1">Address</span>
        <span>Receiving</span>
      </div>
      {ALIASES.map((a, i) => {
        const cycle = i === 1;
        return (
          <div
            key={a.addr}
            className={`flex items-center gap-3 border-b px-5 py-3 last:border-b-0 ${cycle ? "am-site-alias-cycle" : ""}`}
          >
            <MockCheckbox />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-mono font-medium text-[12.5px]">{a.addr}</span>
              <span className="truncate text-[11.5px] text-muted-foreground">
                {a.type} · {a.note}
              </span>
            </span>
            <EllipsisVerticalIcon className="size-3.5 shrink-0 text-muted-foreground" />
            {cycle ? <span className="am-site-toggle am-site-toggle--cycle" /> : <MockSwitch on={a.on} />}
            <span className="hidden w-9 sm:block">
              {cycle ? (
                <span className="am-site-onoff grid">
                  <MockStatus tone="success" className="am-site-onoff-on">
                    On
                  </MockStatus>
                  <MockStatus tone="neutral" className="am-site-onoff-off">
                    Off
                  </MockStatus>
                </span>
              ) : (
                <MockStatus tone={a.on ? "success" : "neutral"}>{a.on ? "On" : "Off"}</MockStatus>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The webmail's message list: new mail lands at the top as it arrives; shortcuts below. */
export function InstantList() {
  return (
    <div aria-hidden="true" className="flex select-none flex-col gap-4 text-left">
      <div className="am-site-panel overflow-hidden">
        <ListHeader />
        {INBOX.slice(0, 4).map((m, i) => (
          <MessageRow
            key={m.subject}
            m={{ ...m, selected: false }}
            className="am-site-instant last:border-b-0"
            style={stagger(i)}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
        <span className="am-site-kbd">j</span>
        <span className="am-site-kbd">k</span>
        <span>move</span>
        <span className="am-site-kbd ml-2">e</span>
        <span>archive</span>
        <span className="am-site-kbd ml-2">/</span>
        <span>search</span>
      </div>
    </div>
  );
}

/** The webmail's reader on a newsletter: remote images stay striped placeholders and the tracker is removed. */
export function TrackerBlocked() {
  return (
    <div aria-hidden="true" className="am-site-panel flex select-none flex-col gap-3.5 p-5 text-left">
      <span className="font-display font-medium text-[17px] tracking-tight">Weekly deals inside</span>
      <div className="flex items-center gap-3 border-y py-2.5">
        <MockAvatar label="CS" tone={4} size="lg" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <span className="font-medium">Corner Store</span>
            <span className="h-3 w-px bg-border" />
            <span className="truncate font-mono text-[11px] text-muted-foreground">promo@store.example</span>
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            To: <span className="font-mono">{DEMO_ME}</span>
          </span>
        </span>
      </div>
      <div className="flex items-start gap-3 rounded-xl border bg-muted/60 px-3.5 py-3">
        <span className="am-site-shield-pulse mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
          <ImageOffIcon className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-[12.5px]">3 remote images blocked · 1 tracker removed</span>
          <span className="am-site-strike w-fit whitespace-nowrap font-mono text-[10.5px] text-muted-foreground">
            pixel.tracker.example
          </span>
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="am-site-blocked-img aspect-[4/3] rounded-lg" />
        <div className="am-site-blocked-img aspect-[4/3] rounded-lg" />
        <div className="am-site-blocked-img aspect-[4/3] rounded-lg" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="am-site-line w-10/12" />
        <div className="am-site-line w-7/12" />
      </div>
    </div>
  );
}

export function TerminalCard() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-[20px] bg-[rgb(var(--am-site-night-deep))] text-white shadow-[var(--am-site-sh-float)] ring-1 ring-white/10"
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-[12px] text-white/60">
        <TerminalIcon className="size-3.5" />
        anhourmail — zsh
      </div>
      <div className="flex min-w-0 flex-col gap-2 overflow-hidden p-5 font-mono text-[12px] leading-relaxed sm:text-[12.5px]">
        <span>
          <span className="text-[rgb(var(--am-cyan-hi))]">$ </span>
          <span className="am-site-type" style={{ "--d": "200ms" } as CSSProperties}>
            git clone github.com/anhourtec/anhourmail
          </span>
        </span>
        <span>
          <span className="text-[rgb(var(--am-cyan-hi))]">$ </span>
          <span className="am-site-type" style={{ "--d": "1700ms" } as CSSProperties}>
            cp .env.example .env &amp;&amp; npm ci
          </span>
        </span>
        <span>
          <span className="text-[rgb(var(--am-cyan-hi))]">$ </span>
          <span className="am-site-type" style={{ "--d": "3200ms" } as CSSProperties}>
            npm run dev
          </span>
          <span className="am-site-caret ml-1" />
        </span>
        <span className="mt-2 text-white/50">AGPL-3.0 · read every line before you trust it</span>
      </div>
    </div>
  );
}
