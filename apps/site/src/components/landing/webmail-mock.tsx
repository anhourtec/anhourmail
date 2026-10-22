// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hand-built pictures of the webmail (not screenshots), drawn after apps/web/src/components/webmail: the sidebar
 * with the mailbox tile, the message list with Pinned and Inbox sections, the reader with its toolbar, sender card,
 * blocked-images notice, attachments, folded quote and inline reply box; the contacts view; and the composer.
 * Sample data only. Decorative and hidden from assistive tech: the surrounding text carries the meaning.
 * Layout follows the picture's own width (container queries), so it reads at 390 px as well as on a desktop.
 */
import type { CSSProperties } from "react";

import {
  ArchiveIcon,
  CakeIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  EllipsisVerticalIcon,
  FilePenIcon,
  FileTextIcon,
  FlagIcon,
  ImageOffIcon,
  InboxIcon,
  MailIcon,
  Maximize2Icon,
  PanelLeftIcon,
  PaperclipIcon,
  PenLineIcon,
  PencilIcon,
  PhoneIcon,
  PinIcon,
  ReplyIcon,
  RotateCwIcon,
  SearchIcon,
  SendIcon,
  ShieldAlertIcon,
  SlidersHorizontalIcon,
  TagIcon,
  Trash2Icon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";

import { HOSTS } from "@anhourmail/shared";

import {
  BrowserFrame,
  DEMO_DOMAIN,
  DEMO_MASKED,
  DEMO_ME,
  MockAvatar,
  NavLabel,
  NavRow,
  SidebarFooter,
  SidebarTile,
  stagger,
} from "./mock-parts";

export type MockMessage = {
  from: string;
  initials: string;
  tone: number;
  subject: string;
  preview: string;
  time: string;
  unread?: boolean;
  pinned?: boolean;
  flagged?: boolean;
  attachment?: boolean;
  thread?: number;
  selected?: boolean;
};

const PINNED: readonly MockMessage[] = [
  {
    from: "Jordan Lee",
    initials: "JL",
    tone: 3,
    subject: "Cabin weekend checklist",
    preview: "Here’s the final list. Tick things off in the group chat when they’re packed.",
    time: "2 days ago",
    pinned: true,
    attachment: true,
  },
];

export const INBOX: readonly MockMessage[] = [
  {
    from: "Lakeside Bikes",
    initials: "LB",
    tone: 1,
    subject: "Your order is on its way",
    preview: "Your new rear light shipped this morning and should arrive by Thursday.",
    time: "9 minutes ago",
    unread: true,
    attachment: true,
    selected: true,
  },
  {
    from: "Sam Rivera",
    initials: "SR",
    tone: 2,
    subject: "Re: Potluck after the run",
    preview: "Sounds good to me. I’ll bring the folding chairs and a big salad.",
    time: "2 hours ago",
    unread: true,
    thread: 3,
  },
  {
    from: "Westside Library",
    initials: "WL",
    tone: 0,
    subject: "Your holds are ready for pickup",
    preview: "Two items are waiting for you at the Westside branch until Friday.",
    time: "18 hours ago",
    flagged: true,
  },
  {
    from: "Priya Shah",
    initials: "PS",
    tone: 2,
    subject: "Garden plan for spring",
    preview: "Attached is the planting plan we talked about, plus the seed list.",
    time: "1 day ago",
    attachment: true,
    thread: 2,
  },
  {
    from: "Harbour Reading Club",
    initials: "HR",
    tone: 4,
    subject: "This month: stories set by the sea",
    preview: "Three new picks, a members’ evening, and the swap shelf is back.",
    time: "2 days ago",
  },
];

/** One message-list row, as in the webmail: avatar square, name, unread dot, thread count, time, subject, icons. */
export function MessageRow({
  m,
  style,
  className = "",
}: {
  m: MockMessage;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      style={style}
      className={`relative flex gap-2.5 border-b px-3 py-2.5 ${m.selected ? "bg-accent" : ""} ${className}`}
    >
      {m.selected ? <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" /> : null}
      <MockAvatar label={m.initials} tone={m.tone} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[18px] items-center gap-1.5">
          <span
            className={`min-w-0 truncate text-[12.5px] ${m.unread ? "font-medium text-foreground" : "text-foreground/80"}`}
          >
            {m.from}
          </span>
          {m.unread ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
          {m.thread ? (
            <span className="rounded border px-1 font-mono text-[9.5px] text-muted-foreground tabular-nums">
              {m.thread}
            </span>
          ) : null}
          <span className="flex-1" />
          <span
            className={`shrink-0 text-[10.5px] tabular-nums ${m.selected ? "text-foreground" : "text-muted-foreground"}`}
          >
            {m.time}
          </span>
        </div>
        <div className="flex h-[18px] items-center gap-1.5">
          <span
            className={`min-w-0 flex-1 truncate text-[12px] ${m.unread ? "font-medium text-foreground" : "text-foreground/75"}`}
          >
            {m.subject}
          </span>
          {m.pinned ? <PinIcon className="size-3 shrink-0 text-muted-foreground" /> : null}
          {m.attachment ? <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" /> : null}
          {m.flagged ? (
            <FlagIcon className="size-3 shrink-0 fill-current text-[rgb(var(--am-status-warning-bg))]" />
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{m.preview}</p>
      </div>
    </div>
  );
}

/** The list pane's header: panel toggle, title, filter, refresh and more; then the search box. */
export function ListHeader({ title = "Inbox" }: { title?: string }) {
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        <PanelLeftIcon className="size-4 text-muted-foreground" />
        <span className="h-4 w-px bg-border" />
        <span className="flex-1 font-display font-medium text-[16px] tracking-tight">{title}</span>
        <SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />
        <RotateCwIcon className="size-3.5 text-muted-foreground" />
        <EllipsisIcon className="size-4 text-muted-foreground" />
      </div>
      <div className="shrink-0 border-b px-2.5 pb-2.5">
        <div className="flex h-7 items-center gap-2 rounded-lg border px-2.5 text-[11.5px] text-muted-foreground">
          <SearchIcon className="size-3.5" />
          <span className="flex-1">Search…</span>
          <span className="font-mono text-[10px]">/</span>
        </div>
      </div>
    </>
  );
}

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="px-3 pt-2.5 pb-1 text-[11px] text-muted-foreground">
      {label} ({count})
    </div>
  );
}

function WebmailSidebar({ active = "inbox" }: { active?: "inbox" | "contacts" }) {
  return (
    <div className="hidden min-h-0 flex-col border-r bg-sidebar @3xl:flex">
      <div className="flex flex-col gap-1 p-2.5 pb-2">
        <div className="flex items-center justify-between border-b pb-2.5">
          <SidebarTile letter="A" />
          <EllipsisVerticalIcon className="size-3.5 text-muted-foreground" />
        </div>
        <span className="pt-1.5 font-medium text-[12.5px]">Alex Morgan</span>
        <span className="truncate font-mono text-[10.5px] text-muted-foreground">{DEMO_ME}</span>
        <span className="mt-2 flex h-8 items-center justify-center gap-2 rounded-lg border bg-card font-medium text-[12.5px] shadow-xs">
          <PenLineIcon className="size-3.5" />
          New email
        </span>
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        <NavRow icon={InboxIcon} label="Inbox" count={2} active={active === "inbox"} />
        <NavRow icon={FlagIcon} label="Priority" count={1} />
        <NavLabel>Folders</NavLabel>
        <NavRow icon={FilePenIcon} label="Drafts" count={1} />
        <NavRow icon={SendIcon} label="Sent" />
        <NavRow icon={ArchiveIcon} label="Archive" />
        <NavRow icon={ShieldAlertIcon} label="Junk" />
        <NavRow icon={Trash2Icon} label="Trash" />
        <div className="h-2" />
        <NavRow icon={UsersIcon} label="Contacts" active={active === "contacts"} />
      </div>
      <SidebarFooter />
    </div>
  );
}

function ToolIcon({ icon: Icon }: { icon: typeof XIcon }) {
  return (
    <span className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground">
      <Icon className="size-3.5" />
    </span>
  );
}

/** The reader: toolbar, subject, sender card, blocked-images notice, body, attachments, folded quote, reply box. */
function Reader() {
  return (
    <div className="hidden min-h-0 min-w-0 flex-col @2xl:flex">
      <div className="flex h-11 shrink-0 items-center gap-0.5 border-b px-2">
        <ToolIcon icon={XIcon} />
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolIcon icon={ChevronLeftIcon} />
        <ToolIcon icon={ChevronRightIcon} />
        <span className="flex-1" />
        <ToolIcon icon={PinIcon} />
        <ToolIcon icon={FlagIcon} />
        <ToolIcon icon={ArchiveIcon} />
        <ToolIcon icon={ReplyIcon} />
        <ToolIcon icon={EllipsisVerticalIcon} />
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolIcon icon={Trash2Icon} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 pt-4">
        <div>
          <span className="block font-display font-medium text-[19px] tracking-tight">Your order is on its way</span>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Thu, 9:41 a.m.</p>
        </div>
        <div className="flex items-center gap-3 border-y py-2.5">
          <MockAvatar label="LB" tone={1} size="lg" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2 text-[12.5px]">
              <span className="font-medium">Lakeside Bikes</span>
              <span className="h-3 w-px bg-border" />
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                orders@lakeside-bikes.example
              </span>
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              To: <span className="font-mono">{DEMO_MASKED}</span>
            </span>
          </div>
        </div>
        <div className="flex items-start gap-2.5 rounded-xl border bg-muted/60 px-3 py-2.5">
          <ImageOffIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium text-[12px]">2 remote images blocked · 1 tracker removed</span>
            <span className="text-[11px] text-muted-foreground">Senders can’t see when or where you opened this.</span>
          </div>
          <span className="hidden h-7 shrink-0 items-center rounded-lg border px-2.5 text-[11px] text-muted-foreground @4xl:inline-flex">
            Load images
          </span>
        </div>
        <div className="flex flex-col gap-2 text-[12.5px] leading-relaxed">
          <p>Hi Alex, your new rear light shipped this morning. It should arrive by Thursday.</p>
          <div className="am-site-line w-11/12" />
          <div className="am-site-line w-9/12" />
        </div>
        <ul className="flex flex-wrap gap-2">
          <li className="flex items-center gap-2 rounded-lg bg-secondary px-2 py-1.5 text-[11.5px]">
            <FileTextIcon className="size-3.5 text-muted-foreground" />
            receipt-2041.pdf
            <span className="font-mono text-[10px] text-muted-foreground">84 KB</span>
          </li>
        </ul>
        <span className="inline-flex h-5 w-8 items-center justify-center rounded-md bg-muted">
          <EllipsisIcon className="size-3.5" />
        </span>
      </div>
      <div className="shrink-0 px-5 pb-4">
        <div className="flex h-10 items-center gap-2.5 rounded-xl border bg-card px-3 text-[12px] text-muted-foreground shadow-xs">
          <ReplyIcon className="size-3.5" />
          <span className="flex-1">Reply to Lakeside Bikes…</span>
          <PaperclipIcon className="size-3.5" />
          <SendIcon className="size-3.5" />
        </div>
      </div>
    </div>
  );
}

export function WebmailMock() {
  return (
    <BrowserFrame
      host={HOSTS.webmail}
      label="Picture of the webmail: folders, an inbox with pinned and new messages, and an open message with its remote images blocked."
    >
      <div className="@container">
        <div className="grid h-[480px] grid-cols-[minmax(0,1fr)] text-[13px] @2xl:grid-cols-[300px_minmax(0,1fr)] @3xl:h-[560px] @3xl:grid-cols-[190px_290px_minmax(0,1fr)] @5xl:grid-cols-[200px_310px_minmax(0,1fr)]">
          <WebmailSidebar />
          <div className="flex min-h-0 min-w-0 flex-col @2xl:border-r">
            <ListHeader />
            <div className="min-h-0 flex-1 overflow-hidden">
              <SectionLabel label="Pinned" count={PINNED.length} />
              {PINNED.map((m) => (
                <MessageRow key={m.subject} m={m} />
              ))}
              <SectionLabel label="Inbox" count={24} />
              {INBOX.map((m, i) => (
                <MessageRow key={m.subject} m={m} className="am-site-instant" style={stagger(i)} />
              ))}
            </div>
          </div>
          <Reader />
        </div>
      </div>
    </BrowserFrame>
  );
}

const CONTACTS = [
  { letter: "E", name: "Elena Petrova", email: "elena@harbour-reading.example", initials: "EP", tone: 2 },
  { letter: "H", name: "Hana Sato", email: "hana@westside-library.example", initials: "HS", tone: 2 },
  { letter: "J", name: "Jordan Lee", email: "jordan@coastal-trail.example", initials: "JL", tone: 3, active: true },
  { letter: "L", name: "Liam Walsh", email: "liam@elm-street.example", initials: "LW", tone: 0 },
  { letter: "M", name: "Maya Chen", email: "maya@piano-studio.example", initials: "MC", tone: 0 },
] as const;

/** The webmail's contacts view: A to Z list with search and label buttons, and the chosen contact's card. */
export function ContactsMock() {
  return (
    <div aria-hidden="true" className="am-site-panel @container select-none overflow-hidden">
      <div className="grid h-[400px] grid-cols-[minmax(0,1fr)] @lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="flex min-h-0 min-w-0 flex-col @lg:border-r">
          <div className="flex h-11 shrink-0 items-center gap-2 px-3">
            <span className="flex-1 font-display font-medium text-[16px] tracking-tight">Contacts</span>
            <UserPlusIcon className="size-3.5 text-muted-foreground" />
            <EllipsisIcon className="size-4 text-muted-foreground" />
          </div>
          <div className="flex shrink-0 flex-col gap-2 border-b px-2.5 pb-2.5">
            <div className="flex h-7 items-center gap-2 rounded-lg border px-2.5 text-[11.5px] text-muted-foreground">
              <SearchIcon className="size-3.5" />
              Search contacts…
            </div>
            <div className="flex gap-1.5 overflow-hidden whitespace-nowrap text-[11px]">
              <span className="rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-primary">
                All <span className="tabular-nums">15</span>
              </span>
              <span className="rounded-full border px-2 py-0.5">My contacts</span>
              <span className="rounded-full border px-2 py-0.5">
                Other contacts <span className="text-muted-foreground tabular-nums">3</span>
              </span>
              <span className="rounded-full border px-2 py-0.5">book club</span>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {CONTACTS.map((c, i) => (
              <div key={c.email} className="am-site-instant" style={stagger(i)}>
                <div className="px-3 pt-1.5 text-[10.5px] text-muted-foreground">{c.letter}</div>
                <div className={`flex items-center gap-2.5 px-3 py-1.5 ${"active" in c ? "bg-accent" : ""}`}>
                  <MockAvatar label={c.initials} tone={c.tone} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[12.5px]">{c.name}</span>
                    <span className="truncate font-mono text-[10.5px] text-muted-foreground">{c.email}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="hidden min-h-0 min-w-0 flex-col @lg:flex">
          <div className="flex h-11 shrink-0 items-center justify-end gap-1 border-b px-2 text-muted-foreground">
            <PencilIcon className="size-3.5" />
            <span className="w-2" />
            <EllipsisIcon className="size-4" />
            <span className="mx-1 h-4 w-px bg-border" />
            <Trash2Icon className="size-3.5" />
          </div>
          <div className="flex flex-col gap-3.5 p-4">
            <div className="flex items-center gap-3">
              <MockAvatar label="JL" tone={3} size="xl" />
              <span className="flex min-w-0 flex-col">
                <span className="font-display font-medium text-[18px] tracking-tight">Jordan Lee</span>
                <span className="text-[11.5px] text-muted-foreground">Coastal Trail Runners</span>
                <span className="text-[11px] text-muted-foreground">My contacts</span>
              </span>
            </div>
            <span className="inline-flex h-8 w-fit items-center gap-2 rounded-lg border px-3 text-[12px]">
              <MailIcon className="size-3.5" />
              Send email
            </span>
            <div className="flex flex-col divide-y rounded-xl border px-3">
              <div className="flex gap-2.5 py-2">
                <MailIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-[11px] text-primary">jordan@coastal-trail.example</span>
                  <span className="text-[10.5px] text-muted-foreground">Email</span>
                </span>
              </div>
              <div className="flex gap-2.5 py-2">
                <PhoneIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex flex-col">
                  <span className="font-mono text-[11px]">+1 555 0142</span>
                  <span className="text-[10.5px] text-muted-foreground">Mobile</span>
                </span>
              </div>
              <div className="flex gap-2.5 py-2">
                <CakeIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex flex-col">
                  <span className="text-[11.5px]">July 4</span>
                  <span className="text-[10.5px] text-muted-foreground">Birthday</span>
                </span>
              </div>
              <div className="flex items-center gap-2.5 py-2">
                <TagIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px]">friends</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const IDENTITIES = [DEMO_ME, `hello@${DEMO_DOMAIN}`, DEMO_MASKED] as const;

/** The composer replying from a masked alias, with the From menu open on the mailbox's own addresses. */
export function ComposerMock() {
  return (
    <div aria-hidden="true" className="am-site-panel @container select-none overflow-hidden">
      <div className="flex h-11 items-center justify-between border-b px-4">
        <span className="font-medium text-[13px]">Reply</span>
        <span className="flex items-center gap-3 text-muted-foreground">
          <Maximize2Icon className="size-3.5" />
          <XIcon className="size-3.5" />
        </span>
      </div>
      <div className="relative flex h-10 items-center gap-3 border-b px-4 text-[12px]">
        <span className="w-9 shrink-0 text-muted-foreground">From</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{DEMO_MASKED}</span>
        <ChevronDownIcon className="size-3.5 shrink-0" />
        <div className="absolute top-[calc(100%-4px)] right-3 left-14 z-10 flex flex-col gap-0.5 rounded-xl border bg-popover p-1 shadow-lg">
          {IDENTITIES.map((addr) => (
            <span
              key={addr}
              className={`flex h-7 items-center gap-2 rounded-md px-2 font-mono text-[11px] ${addr === DEMO_MASKED ? "bg-accent" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate">{addr}</span>
              {addr === DEMO_MASKED ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
            </span>
          ))}
        </div>
      </div>
      <div className="flex min-h-10 items-center gap-3 border-b px-4 py-1.5 text-[12px]">
        <span className="w-9 shrink-0 text-muted-foreground">To</span>
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-secondary px-2 py-0.5">
          <span className="shrink-0">Lakeside Bikes</span>
          <span className="truncate font-mono text-[10.5px] text-muted-foreground">orders@lakeside-bikes.example</span>
          <XIcon className="size-3 shrink-0 text-muted-foreground" />
        </span>
        <span className="ml-auto hidden shrink-0 text-[11px] text-muted-foreground @md:inline">Cc Bcc</span>
      </div>
      <div className="flex h-10 items-center border-b px-4 text-[12px]">Re: Your order is on its way</div>
      <div className="flex min-h-[120px] flex-col gap-2 px-4 pt-3 pb-4 text-[12.5px]">
        <p>Thanks — could you leave it with the building’s front desk?</p>
        <div className="am-site-line w-7/12" />
      </div>
      <div className="flex items-center gap-3 border-t px-4 py-3">
        <span className="inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3.5 font-medium text-[12.5px] text-primary-foreground">
          <SendIcon className="size-3.5" />
          Send
        </span>
        <span className="hidden text-[11px] text-muted-foreground @sm:inline">⌘/Ctrl + Enter</span>
        <span className="flex-1" />
        <PaperclipIcon className="size-3.5 text-muted-foreground" />
        <Trash2Icon className="size-3.5 text-muted-foreground" />
      </div>
    </div>
  );
}
