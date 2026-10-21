// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties } from "react";

import {
  ArchiveIcon,
  FileIcon,
  ImageOffIcon,
  InboxIcon,
  LockIcon,
  SendIcon,
  ShieldAlertIcon,
  StarIcon,
  VenetianMaskIcon,
} from "lucide-react";

import { HOSTS } from "@anhourmail/shared";

/**
 * A hand-built picture of the webmail (not a screenshot): folder list, message list, reading pane with remote
 * images blocked and a masked alias. Sample data only. Decorative — hidden from assistive tech.
 */
const FOLDERS = [
  { icon: InboxIcon, label: "Inbox", count: 3, active: true },
  { icon: StarIcon, label: "Starred" },
  { icon: SendIcon, label: "Sent" },
  { icon: FileIcon, label: "Drafts" },
  { icon: ArchiveIcon, label: "Archive" },
  { icon: ShieldAlertIcon, label: "Junk" },
] as const;

const ROWS = [
  {
    from: "Lena from the bike shop",
    subject: "Your order is on its way",
    preview: "Tracking details and a note about the rear light…",
    time: "9:41",
    unread: true,
    selected: true,
    masked: true,
  },
  {
    from: "Sam Okafor",
    subject: "Saturday hike?",
    preview: "Forecast looks clear. Trailhead at 8, I'll bring coffee.",
    time: "9:02",
    unread: true,
  },
  {
    from: "Library notices",
    subject: "2 items due next week",
    preview: "Renew online or drop them at any branch.",
    time: "Mon",
    unread: true,
  },
  {
    from: "Priya Natarajan",
    subject: "Photos from the weekend",
    preview: "Uploaded the album, link inside. The lake ones…",
    time: "Sun",
  },
  {
    from: "City utilities",
    subject: "Your October statement",
    preview: "Statement ready. Autopay is on for this account.",
    time: "Sat",
  },
  {
    from: "Dana (book club)",
    subject: "Next pick",
    preview: "Voting closes Friday — three titles on the list.",
    time: "Fri",
  },
] as const;

export function WebmailMock() {
  return (
    <div aria-hidden="true" className="am-site-frame select-none">
      <div className="am-site-frame-bar">
        <span className="flex gap-1.5">
          <span className="am-site-frame-dot" />
          <span className="am-site-frame-dot" />
          <span className="am-site-frame-dot" />
        </span>
        <span className="am-site-frame-url">
          <LockIcon className="size-3" />
          {HOSTS.webmail}
        </span>
        <span className="w-[42px]" />
      </div>
      <div className="am-site-mock">
        {/* folders */}
        <div className="hidden flex-col gap-1 border-r p-3 lg:flex">
          <div className="mb-2 flex h-9 items-center justify-center rounded-lg bg-[rgb(var(--am-btn))] font-medium text-white">
            Compose
          </div>
          {FOLDERS.map((f) => (
            <div key={f.label} className="am-site-mock-folder" data-active={"active" in f ? "" : undefined}>
              <f.icon className="size-4" />
              <span className="flex-1">{f.label}</span>
              {"count" in f ? <span className="am-num text-[11px]">{f.count}</span> : null}
            </div>
          ))}
          <div className="mt-4 mb-1 px-2.5 text-[11px] uppercase tracking-wider text-muted-foreground">Aliases</div>
          <div className="am-site-mock-folder">
            <VenetianMaskIcon className="size-4" />
            <span className="truncate">shop-k7q2</span>
          </div>
          <div className="am-site-mock-folder">
            <VenetianMaskIcon className="size-4" />
            <span className="truncate">news-3vd8</span>
          </div>
        </div>
        {/* message list */}
        <div className="flex min-w-0 flex-col border-r">
          <div className="flex h-11 items-center justify-between border-b px-4">
            <span className="font-medium">Inbox</span>
            <span className="am-site-chip am-site-chip--success">Up to date</span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {ROWS.map((r, i) => (
              <div
                key={r.subject}
                className="am-site-mock-row am-site-instant"
                style={{ "--i": i } as CSSProperties}
                data-unread={"unread" in r ? "" : undefined}
                data-selected={"selected" in r ? "" : undefined}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className={`truncate ${"unread" in r ? "font-semibold" : ""}`}>{r.from}</span>
                  <span className="am-num shrink-0 text-[11px] text-muted-foreground">{r.time}</span>
                </div>
                <span className="truncate">{r.subject}</span>
                <span className="truncate text-[12px] text-muted-foreground">{r.preview}</span>
              </div>
            ))}
          </div>
        </div>
        {/* reading pane */}
        <div className="hidden min-w-0 flex-col gap-4 p-6 md:flex">
          <h3 className="font-display text-[19px] font-medium tracking-tight">Your order is on its way</h3>
          <div className="flex items-center gap-3">
            <span className="inline-flex size-9 items-center justify-center rounded-full bg-[rgb(var(--am-btn)/0.12)] font-medium text-[rgb(var(--am-btn))]">
              L
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="font-medium">Lena from the bike shop</span>
              <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                to
                <span className="am-site-chip">
                  <VenetianMaskIcon className="size-3" />
                  shop-k7q2 · masked alias
                </span>
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-2.5">
            <span className="flex items-center gap-2 text-[12.5px]">
              <ImageOffIcon className="size-4 text-muted-foreground" />
              Remote images blocked — 1 tracker stopped
            </span>
            <span className="rounded-md border px-2 py-1 text-[11.5px]">Load images</span>
          </div>
          <div className="flex flex-col gap-2.5 pt-1">
            <p className="text-[13px] leading-relaxed">
              Hi! Your new rear light shipped this morning. It should arrive by Thursday.
            </p>
            <div className="am-site-line w-11/12" />
            <div className="am-site-line w-10/12" />
            <div className="am-site-line w-8/12" />
            <div className="am-site-line w-9/12" />
          </div>
        </div>
      </div>
    </div>
  );
}
