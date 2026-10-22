// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hand-built pictures of the console (not screenshots), drawn after apps/web/src/components/console: the navy app
 * bar, the left navigation with the identity block, primary action and counted sections, and two pages — home (the
 * greeting and a recommendation) and the aliases list (breadcrumb, title, command bar, filter chips, checkboxes,
 * switches, status text). Also the audit log as a compact card. Sample data only; decorative and hidden from
 * assistive tech. Layout follows the picture's own width (container queries).
 */
import {
  ArrowUpIcon,
  AtSignIcon,
  ChevronRightIcon,
  CreditCardIcon,
  EllipsisIcon,
  EllipsisVerticalIcon,
  GlobeIcon,
  HouseIcon,
  InboxIcon,
  MailIcon,
  PlusIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SearchIcon,
  ShieldIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";

import { BRAND, HOSTS } from "@anhourmail/shared";

import {
  BrowserFrame,
  ConsoleAppBar,
  DEMO_DOMAIN,
  DEMO_ME,
  MockCheckbox,
  MockStatus,
  MockSwitch,
  NavLabel,
  NavRow,
  SidebarFooter,
  SidebarTile,
  stagger,
} from "./mock-parts";

const ACCOUNT = "Morgan Family";

function ConsoleNav({ active }: { active: "home" | "aliases" }) {
  return (
    <div className="hidden min-h-0 flex-col border-r bg-sidebar @3xl:flex">
      <div className="flex flex-col gap-1 p-2.5 pb-2">
        <div className="flex items-center justify-between border-b pb-2.5">
          <SidebarTile letter="M" />
          <EllipsisVerticalIcon className="size-3.5 text-muted-foreground" />
        </div>
        <span className="pt-1.5 font-medium text-[12.5px]">Alex Morgan</span>
        <span className="truncate font-mono text-[10.5px] text-muted-foreground">{ACCOUNT} · Owner</span>
        <span className="mt-2 flex h-8 items-center justify-center gap-2 rounded-lg border bg-card font-medium text-[12.5px] shadow-xs">
          <InboxIcon className="size-3.5" />
          New mailbox
        </span>
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        <NavRow icon={HouseIcon} label="Home" active={active === "home"} />
        <NavLabel>Mail</NavLabel>
        <NavRow icon={InboxIcon} label="Mailboxes" count={3} />
        <NavRow icon={AtSignIcon} label="Aliases" count={4} active={active === "aliases"} />
        <NavRow icon={GlobeIcon} label="Domains" count={1} />
        <NavLabel>People</NavLabel>
        <NavRow icon={UsersIcon} label="People and roles" count={3} />
        <NavLabel>Account</NavLabel>
        <NavRow icon={CreditCardIcon} label="Billing" count="Soon" />
        <NavRow icon={ScrollTextIcon} label="Audit log" />
      </div>
      <SidebarFooter />
    </div>
  );
}

function Breadcrumb({ page }: { page: string }) {
  return (
    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
      Home
      <ChevronRightIcon className="size-3" />
      <span className="text-foreground">{page}</span>
    </div>
  );
}

function HomePage() {
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4 @2xl:p-6">
      <div className="flex gap-4 overflow-hidden whitespace-nowrap rounded-xl border bg-card px-3.5 py-2.5 text-[12px] shadow-xs">
        <span className="flex items-center gap-1.5">
          <InboxIcon className="size-3.5 text-primary" />
          Add a mailbox
        </span>
        <span className="flex items-center gap-1.5">
          <UserPlusIcon className="size-3.5 text-primary" />
          Invite someone
        </span>
        <span className="flex items-center gap-1.5">
          <GlobeIcon className="size-3.5 text-primary" />
          Add a domain
        </span>
        <span className="flex items-center gap-1.5">
          <AtSignIcon className="size-3.5 text-primary" />
          Add an alias
        </span>
        <span className="flex items-center gap-1.5">
          <MailIcon className="size-3.5 text-primary" />
          Open webmail
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="font-display font-medium text-[26px] tracking-tight @2xl:text-[30px]">
          Good afternoon, Alex
        </span>
        <span className="text-[12px] text-muted-foreground">Mail, domains and people for {ACCOUNT}, in one place.</span>
      </div>
      <span className="font-display font-medium text-[16px] tracking-tight">Recommended for you</span>
      <div className="flex max-w-[460px] gap-3 rounded-xl border border-l-[3px] border-l-[rgb(var(--am-status-warning-bg))] bg-card p-3.5 shadow-xs">
        <GlobeIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-[13px]">Finish setting up {DEMO_DOMAIN}</span>
          <span className="text-[12px] text-muted-foreground">
            Add its DNS records at your DNS provider. Mail starts arriving once they’re in place.
          </span>
          <span className="mt-1 text-[12px] text-primary">See the records</span>
        </div>
      </div>
      <div className="flex flex-col gap-2 pt-1">
        <span className="font-display font-medium text-[16px] tracking-tight">Your account</span>
        <div className="flex gap-4 border-b text-[12px] text-muted-foreground">
          <span className="border-b-2 border-foreground pb-2 font-medium text-foreground">Mailboxes (3)</span>
          <span>People (3)</span>
          <span className="hidden @md:inline">Domains (1)</span>
          <span className="hidden @xl:inline">Recent activity</span>
        </div>
        {[DEMO_ME, `jamie@${DEMO_DOMAIN}`].map((m, i) => (
          <div
            key={m}
            className="am-site-instant flex items-center justify-between gap-3 border-b py-2"
            style={stagger(i)}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-[12px]">{m}</span>
              <span className="truncate text-[11px] text-muted-foreground">Belongs to {m}</span>
            </span>
            <MockStatus tone="success">Active</MockStatus>
          </div>
        ))}
      </div>
    </div>
  );
}

export const ALIASES = [
  { addr: `3f9a1c07d2@${DEMO_DOMAIN}`, type: "Masked", note: "lakeside-bikes.example", on: true },
  { addr: `8be2d41a90@${DEMO_DOMAIN}`, type: "Masked", note: "newsletter.example", on: false },
  { addr: `c71d05e3bb@${DEMO_DOMAIN}`, type: "Masked", note: "airline.example", on: true },
  { addr: `hello@${DEMO_DOMAIN}`, type: "Alias", note: "Shared hello address", on: true },
] as const;

function AliasesPage() {
  return (
    <div className="flex min-w-0 flex-col p-4 @2xl:p-6">
      <Breadcrumb page="Aliases" />
      <span className="mt-1.5 font-display font-medium text-[26px] tracking-tight @2xl:text-[30px]">Aliases</span>
      <p className="mt-1 max-w-[56ch] text-[12px] text-muted-foreground">
        More addresses for the same mailbox. Masked aliases are random ones to give a single site, so you can turn them
        off when they start getting spam.
      </p>
      <span className="mt-2 font-mono text-[11px] text-muted-foreground">
        In this account: 1 alias · 3 masked aliases
      </span>
      <div className="mt-3 flex items-center gap-4 border-t py-2.5 text-[12px]">
        <span className="flex items-center gap-1.5">
          <PlusIcon className="size-3.5 text-primary" />
          Add an alias
        </span>
        <span className="hidden items-center gap-1.5 @md:flex">
          <RefreshCwIcon className="size-3.5 text-primary" />
          Refresh
        </span>
        <span className="flex-1" />
        <span className="hidden h-7 w-44 items-center gap-2 rounded-md border px-2 text-[11.5px] text-muted-foreground @2xl:flex">
          <SearchIcon className="size-3.5" />
          Search this list
        </span>
        <EllipsisIcon className="size-4 text-muted-foreground" />
      </div>
      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap pb-3 text-[11.5px]">
        <span className="text-muted-foreground">Show:</span>
        <span className="rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-primary">
          All <span className="tabular-nums">4</span>
        </span>
        <span className="rounded-full border px-2 py-0.5">
          Aliases <span className="text-muted-foreground tabular-nums">1</span>
        </span>
        <span className="rounded-full border px-2 py-0.5">
          Masked <span className="text-muted-foreground tabular-nums">3</span>
        </span>
        <span className="rounded-full border px-2 py-0.5">
          Off <span className="text-muted-foreground tabular-nums">1</span>
        </span>
      </div>
      <div className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 border-b px-2 pb-2 text-[11px] font-medium @2xl:grid-cols-[14px_minmax(0,1.5fr)_60px_minmax(0,1fr)_96px]">
        <MockCheckbox />
        <span className="flex items-center gap-1">
          Address <ArrowUpIcon className="size-3" />
        </span>
        <span className="hidden @2xl:block">Type</span>
        <span className="hidden @2xl:block">Note</span>
        <span>Receiving</span>
      </div>
      {ALIASES.map((a, i) => (
        <div
          key={a.addr}
          className="am-site-instant grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 border-b px-2 py-2.5 @2xl:grid-cols-[14px_minmax(0,1.5fr)_60px_minmax(0,1fr)_96px]"
          style={stagger(i)}
        >
          <MockCheckbox />
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono font-medium text-[11.5px]">{a.addr}</span>
            <EllipsisVerticalIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </span>
          <span className="hidden text-[12px] @2xl:block">{a.type}</span>
          <span className="hidden truncate text-[12px] @2xl:block">{a.note}</span>
          <span className="flex items-center gap-2">
            <MockSwitch on={a.on} />
            <MockStatus tone={a.on ? "success" : "neutral"}>{a.on ? "On" : "Off"}</MockStatus>
          </span>
        </div>
      ))}
    </div>
  );
}

/** The console in a browser frame, on its home page or the aliases list. */
export function ConsoleMock({ view }: { view: "home" | "aliases" }) {
  return (
    <BrowserFrame
      host={HOSTS.app}
      label={
        view === "home"
          ? "Picture of the console home page: a greeting, a reminder to finish setting up a domain, and the account’s mailboxes."
          : "Picture of the console’s aliases list: masked aliases with notes, and a switch to turn each one off."
      }
    >
      <div className="@container text-left">
        <ConsoleAppBar account={ACCOUNT} initials="MF" />
        <div className="grid h-[440px] grid-cols-[minmax(0,1fr)] overflow-hidden @3xl:h-[580px] @3xl:grid-cols-[200px_minmax(0,1fr)]">
          <ConsoleNav active={view} />
          <div className="min-h-0 overflow-hidden">{view === "home" ? <HomePage /> : <AliasesPage />}</div>
        </div>
      </div>
    </BrowserFrame>
  );
}

const AUDIT = [
  {
    who: `${BRAND.company} staff`,
    role: "Support",
    staff: true,
    what: "Staff started acting as someone",
    area: `${BRAND.company} staff`,
    when: "14:02 UTC",
  },
  { who: DEMO_ME, role: "Owner", what: "Masked alias created", area: "Masked aliases", when: "13:47 UTC" },
  { who: "System", role: "Automatic check", what: "Domain verified", area: "Domains", when: "13:31 UTC" },
  { who: DEMO_ME, role: "Owner", what: "Mailbox created", area: "Mailboxes", when: "13:18 UTC" },
] as const;

/** The audit log as a compact card: who, what and result, with staff entries labelled as staff. */
export function AuditMock() {
  return (
    <div aria-hidden="true" className="am-site-panel @container select-none overflow-hidden text-left">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="flex items-center gap-2 font-medium text-sm">
          <ScrollTextIcon className="size-4 text-primary" />
          Audit log
        </span>
        <span className="flex items-center gap-1.5 text-[12px]">
          <RefreshCwIcon className="size-3.5 text-primary" />
          Newest entries
        </span>
      </div>
      <div className="hidden grid-cols-[72px_minmax(0,1fr)_minmax(0,1.1fr)_auto] gap-3 border-b px-4 py-2 font-medium text-[11px] @lg:grid">
        <span>When</span>
        <span>Who</span>
        <span>What</span>
        <span>Result</span>
      </div>
      {AUDIT.map((e, i) => (
        <div
          key={e.what}
          className={`am-site-instant grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 last:border-b-0 @lg:grid-cols-[72px_minmax(0,1fr)_minmax(0,1.1fr)_auto] ${"staff" in e ? "bg-[rgb(var(--am-status-warning-bg)/0.08)]" : ""}`}
          style={stagger(i)}
        >
          <span className="hidden font-mono text-[11px] @lg:block">{e.when}</span>
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
              {"staff" in e ? <ShieldIcon className="size-3.5 shrink-0 text-[rgb(var(--am-status-warning))]" /> : null}
              <span className="truncate">{e.who}</span>
            </span>
            <span className="text-[10.5px] text-muted-foreground">{e.role}</span>
          </span>
          <span className="col-start-1 flex min-w-0 flex-col @lg:col-start-auto">
            <span className="truncate font-medium text-[12px]">{e.what}</span>
            <span className="truncate text-[10.5px] text-muted-foreground">{e.area}</span>
          </span>
          <MockStatus tone="success" className="row-start-1 col-start-2 @lg:row-start-auto @lg:col-start-auto">
            Success
          </MockStatus>
        </div>
      ))}
    </div>
  );
}
