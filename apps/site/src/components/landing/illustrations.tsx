// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Small animated illustrations for the feature rows. Animations start when the surrounding <Reveal> sets
 * data-revealed, and stop under prefers-reduced-motion (site.css). Decorative: hidden from assistive tech;
 * each row's heading and text carry the meaning.
 */
import type { CSSProperties } from "react";

import { CheckIcon, ImageOffIcon, Loader2Icon, ShieldCheckIcon, TerminalIcon, VenetianMaskIcon } from "lucide-react";

import { customerDomainRecords } from "@anhourmail/shared";

const v = (i: number) => ({ "--i": i }) as CSSProperties;

export function DnsChecks() {
  const records = customerDomainRecords("yourname.com", "demo").filter((r) => r.required);
  return (
    <div aria-hidden="true" className="am-site-panel overflow-hidden">
      <div className="flex items-center justify-between border-b px-5 py-3.5">
        <span className="font-medium text-sm">yourname.com</span>
        <span className="am-site-chip am-site-chip--warning">Checking DNS…</span>
      </div>
      <ul className="divide-y">
        {records.map((r, i) => (
          <li
            key={`${r.type}-${r.name}`}
            className="am-site-dns-row grid grid-cols-[56px_1fr_24px] items-center gap-3 px-5 py-3"
            style={v(i)}
          >
            <span className="am-code rounded-md bg-muted px-1.5 py-0.5 text-center text-[11px]">{r.type}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm">
                {r.name === "@" ? "yourname.com" : `${r.name}.yourname.com`}
              </span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">{r.value}</span>
            </span>
            <span className="grid grid-cols-[minmax(0,1fr)]">
              <Loader2Icon className="am-site-dns-wait am-site-spin size-4 text-muted-foreground" />
              <span className="am-site-dns-ok inline-flex size-5 items-center justify-center rounded-full bg-[rgb(var(--am-status-success-bg))] text-white">
                <CheckIcon className="size-3" strokeWidth={3} />
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ALIASES = [
  { addr: "shop-k7q2", site: "bike-shop.example", mail: 14, cycle: false },
  { addr: "news-3vd8", site: "newsletter.example", mail: 63, cycle: true },
  { addr: "trip-9xa1", site: "airline.example", mail: 5, cycle: false },
] as const;

export function AliasToggles() {
  return (
    <div aria-hidden="true" className="am-site-panel flex flex-col divide-y">
      {ALIASES.map((a) => (
        <div key={a.addr} className={`flex items-center gap-4 px-5 py-4 ${a.cycle ? "am-site-alias-cycle" : ""}`}>
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-[rgb(var(--am-btn)/0.1)] text-[rgb(var(--am-btn))]">
            <VenetianMaskIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-[13px]">{a.addr}@yourname.com</span>
            <span className="block truncate text-[12px] text-muted-foreground">
              {a.site} · <span className="am-num">{a.mail}</span> messages
            </span>
          </span>
          <span className={`am-site-toggle ${a.cycle ? "am-site-toggle--cycle" : ""}`} />
        </div>
      ))}
    </div>
  );
}

const INSTANT = [
  ["Sam Okafor", "Saturday hike?"],
  ["Library notices", "2 items due next week"],
  ["Priya Natarajan", "Photos from the weekend"],
  ["City utilities", "Your October statement"],
] as const;

export function InstantList() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <div className="am-site-panel overflow-hidden">
        {INSTANT.map(([from, subject], i) => (
          <div
            key={subject}
            className="am-site-instant flex items-center gap-3 border-b px-5 py-3.5 last:border-b-0"
            style={v(i)}
          >
            <span className="size-1.5 shrink-0 rounded-full bg-[rgb(var(--am-btn))]" />
            <span className="w-28 shrink-0 truncate font-medium text-sm sm:w-36">{from}</span>
            <span className="truncate text-muted-foreground text-sm">{subject}</span>
          </div>
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

export function TrackerBlocked() {
  return (
    <div aria-hidden="true" className="am-site-panel flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">Weekly deals inside</span>
        <span className="text-[12px] text-muted-foreground">promo@store.example</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="flex aspect-[4/3] items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ImageOffIcon className="size-5" />
        </div>
        <div className="flex aspect-[4/3] items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ImageOffIcon className="size-5" />
        </div>
        <div className="flex aspect-[4/3] items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ImageOffIcon className="size-5" />
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-xl bg-[rgb(var(--am-status-success-bg)/0.1)] px-4 py-3">
        <span className="am-site-shield-pulse inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--am-status-success-bg))] text-white">
          <ShieldCheckIcon className="size-4" />
        </span>
        <span className="flex flex-col text-[13px]">
          <span className="font-medium">Tracking pixel stopped</span>
          <span className="am-site-strike w-fit font-mono text-[11.5px] text-muted-foreground">
            1×1 image · pixel.tracker.example
          </span>
        </span>
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
