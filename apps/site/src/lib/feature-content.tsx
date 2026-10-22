// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import type { ReactNode } from "react";

import {
  ArchiveIcon,
  AtSignIcon,
  BarChart3Icon,
  BellIcon,
  CodeIcon,
  ContactRoundIcon,
  DownloadIcon,
  EyeOffIcon,
  FilterIcon,
  GlobeIcon,
  HistoryIcon,
  ImageOffIcon,
  KeyRoundIcon,
  KeyboardIcon,
  LayersIcon,
  MonitorSmartphoneIcon,
  PlugIcon,
  PowerOffIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TrashIcon,
  VenetianMaskIcon,
  WandIcon,
  ZapIcon,
} from "lucide-react";

import { customerDomainRecords, PLAN_ORDER, PLANS } from "@anhourmail/shared";

import { AuditMock, ConsoleMock } from "@/components/landing/console-mock";
import { DkimRotation, SettingsCard } from "@/components/landing/extra-art";
import { AliasToggles, DnsChecks, InstantList, TrackerBlocked } from "@/components/landing/illustrations";
import { ComposerMock, ContactsMock, WebmailMock } from "@/components/landing/webmail-mock";

import { type FeatureSlug, PROTOCOL_LIST } from "./ia";

type Icon = typeof GlobeIcon;
type Row = {
  icon: Icon;
  label: string;
  title: string;
  body: string;
  bullets: readonly string[];
  bloom: "blue" | "cyan" | "green" | "amber" | "violet";
  art: ReactNode;
};

export type FeatureContent = {
  eyebrow: string;
  title: string;
  lead: string;
  description: string;
  heroArt: ReactNode;
  rows: readonly Row[];
  detailsTitle: string;
  details: readonly { icon: Icon; title: string; body: string }[];
  faq: readonly { q: string; a: ReactNode }[];
  related: readonly FeatureSlug[];
};

const paidWith = (k: "customDomains" | "catchAll") =>
  PLAN_ORDER.filter((id) => PLANS[id][k])
    .map((id) => PLANS[id].name)
    .join(" and ");
const requiredRecords = customerDomainRecords("example.com", "x").filter((r) => r.required).length;
const limit = (n: number | null) => (n === null ? "unlimited" : String(n));

export const FEATURE_CONTENT: Record<FeatureSlug, FeatureContent> = {
  "custom-domains": {
    eyebrow: "Custom domains",
    title: "Your address, your domain",
    lead: "Use the domain you already own. We show every DNS record, check each one live, and look after the signing keys.",
    description:
      "Use your own domain with AnhourMail: guided DNS setup, live per-record checks and automatic DKIM key rotation.",
    heroArt: <ConsoleMock view="home" />,
    rows: [
      {
        icon: GlobeIcon,
        label: "Guided setup",
        title: "Copy, paste, watch it go green.",
        body: `You add ${String(requiredRecords)} required records at your DNS provider. Each one has a copy button and its own live check, so you always know exactly what’s left.`,
        bullets: [
          "Step-by-step guides for popular DNS providers",
          "Live check per record",
          "Mail starts flowing as soon as the MX record passes",
        ],
        bloom: "blue",
        art: <DnsChecks />,
      },
      {
        icon: KeyRoundIcon,
        label: "Signing keys",
        title: "We rotate DKIM keys. You never touch DNS again.",
        body: "Your domain points two signing records at us once. We publish fresh keys behind them on a schedule, so your mail stays trusted without you lifting a finger.",
        bullets: [
          "Two selectors for seamless rotation",
          "Strong RSA keys mail providers accept",
          "No DNS changes after setup",
        ],
        bloom: "cyan",
        art: <DkimRotation />,
      },
    ],
    detailsTitle: "The details that matter",
    details: [
      {
        icon: AtSignIcon,
        title: "Catch-all",
        body: `Receive mail sent to any address at your domain. On ${paidWith("catchAll")}.`,
      },
      {
        icon: LayersIcon,
        title: "Several domains",
        body: `Add more than one domain to an account on ${paidWith("customDomains")}.`,
      },
      {
        icon: WandIcon,
        title: "App autoconfig",
        body: "Optional records let mail apps set themselves up from your address.",
      },
      {
        icon: ShieldCheckIcon,
        title: "SPF, DKIM and DMARC",
        body: "Every record mail providers check, explained in plain words.",
      },
    ],
    faq: [
      {
        q: "Which plans include custom domains?",
        a: `${paidWith("customDomains")}. The free plan uses an address on our domain.`,
      },
      {
        q: "Can I keep my domain where it’s registered?",
        a: "Yes. You only change DNS records; the domain stays with your registrar.",
      },
      {
        q: "What if I make a mistake?",
        a: (
          <>
            The live check shows which record is wrong and what it should be. The{" "}
            <Link href="/docs/custom-domain">custom domain guide</Link> walks through every step.
          </>
        ),
      },
    ],
    related: ["aliases", "apps"],
  },
  aliases: {
    eyebrow: "Aliases",
    title: "A different address for every sign-up",
    lead: "Give every shop, newsletter and app its own address. See which ones get mail, and switch any of them off the moment it’s sold.",
    description:
      "Aliases and masked aliases on AnhourMail: random per-site addresses, per-alias stats and a one-click off switch.",
    heroArt: <ConsoleMock view="aliases" />,
    rows: [
      {
        icon: VenetianMaskIcon,
        label: "Masked aliases",
        title: "Random addresses that protect the real one.",
        body: "Create a masked alias for each site you sign up to. Mail arrives in your inbox as usual, and the site never learns your real address.",
        bullets: ["One click to create", "Notes so you remember what each is for", "Replies go out from the alias"],
        bloom: "violet",
        art: <ComposerMock />,
      },
      {
        icon: BarChart3Icon,
        label: "Know who leaked it",
        title: "Spam on an alias? You know exactly who sold it.",
        body: "Every alias counts the mail it receives. When one starts getting junk, switch it off — nothing else changes.",
        bullets: ["A note on each alias", "Turn off without deleting", "Turn back on any time"],
        bloom: "blue",
        art: <AliasToggles />,
      },
    ],
    detailsTitle: "Every kind of address",
    details: [
      {
        icon: AtSignIcon,
        title: "Chosen aliases",
        body: "Pick readable extra addresses like hello@ or shop@ on your domain.",
      },
      {
        icon: SparklesIcon,
        title: "Plus addressing",
        body: "Add +anything to your address on the fly — no setup needed.",
      },
      {
        icon: PowerOffIcon,
        title: "Off switch",
        body: "Stop mail to an alias instantly, and bring it back later if you want.",
      },
      {
        icon: LayersIcon,
        title: "Generous limits",
        body: `Free: ${limit(PLANS.free.aliases)} aliases and ${limit(PLANS.free.maskedAliases)} masked aliases. ${PLANS.plus.name}: ${limit(PLANS.plus.aliases)}.`,
      },
    ],
    faq: [
      {
        q: "Can I reply from an alias?",
        a: "Yes. Replies go out from the alias the mail was sent to, so your main address stays private.",
      },
      {
        q: "What happens to mail sent to a switched-off alias?",
        a: "It is refused, so the sender learns the address no longer works.",
      },
      {
        q: "Are masked aliases the same as a forwarding service?",
        a: "Similar idea, but built into your mailbox: no separate account, and mail never passes through a third party.",
      },
    ],
    related: ["privacy", "custom-domains"],
  },
  webmail: {
    eyebrow: "Webmail",
    title: "Webmail that feels instant",
    lead: "Built on JMAP, the modern mail protocol, so it syncs only what changed and shows new mail the moment it arrives.",
    description:
      "AnhourMail's open-source webmail: JMAP sync, push updates, keyboard shortcuts and safe rendering of every message.",
    heroArt: <WebmailMock />,
    rows: [
      {
        icon: ZapIcon,
        label: "JMAP sync",
        title: "Only what changed, as soon as it changes.",
        body: "Instead of re-downloading folders, the webmail asks for what changed since last time and listens for new mail. Big mailboxes stay fast.",
        bullets: ["Incremental sync", "Push updates, no polling", "Local cache for instant folder switching"],
        bloom: "cyan",
        art: <InstantList />,
      },
      {
        icon: ImageOffIcon,
        label: "Safe by default",
        title: "Every message opens in a locked room.",
        body: "Mail is cleaned before it’s shown and rendered in an isolated frame with scripts off. Remote images wait for your say-so.",
        bullets: ["Sanitised HTML", "No scripts, ever", "Remote images blocked until you allow them"],
        bloom: "green",
        art: <TrackerBlocked />,
      },
      {
        icon: ContactRoundIcon,
        label: "Contacts",
        title: "The people you write to, next to your mail.",
        body: "An address book with search and labels sits beside your folders. People you email are saved for you, and your contacts sync to your phone and computer.",
        bullets: ["Labels, notes and birthdays", "Import and export vCard files", "Sync over CardDAV"],
        bloom: "violet",
        art: <ContactsMock />,
      },
    ],
    detailsTitle: "Made for people who live in their inbox",
    details: [
      {
        icon: KeyboardIcon,
        title: "Keyboard shortcuts",
        body: "Move, archive, reply and search without reaching for the mouse.",
      },
      { icon: FilterIcon, title: "Filters", body: "Sort mail automatically with rules that run on the server." },
      { icon: ArchiveIcon, title: "Threads", body: "Conversations grouped together, newest first." },
      {
        icon: BellIcon,
        title: "Status",
        body: "The webmail arrives with the beta. Until then, any IMAP app works.",
      },
    ],
    faq: [
      {
        q: "Is the webmail open source?",
        a: "Yes, like the rest of AnhourMail’s apps. You can read and run the code.",
      },
      { q: "Can I keep using my mail app?", a: `Yes. ${PROTOCOL_LIST} all work alongside the webmail.` },
    ],
    related: ["apps", "privacy"],
  },
  privacy: {
    eyebrow: "Privacy",
    title: "Private by default, not by setting",
    lead: "No ads, no tracking, no profiling. The protections are switched on from the first message — you don’t have to find them.",
    description:
      "How AnhourMail keeps your mail private: no ads or tracking, remote images blocked, and staff actions you can see.",
    heroArt: <TrackerBlocked />,
    rows: [
      {
        icon: EyeOffIcon,
        label: "No tracking",
        title: "Senders can’t watch you read.",
        body: "Tracking pixels are tiny remote images that tell a sender when and where you opened their mail. We block remote images until you choose to load them.",
        bullets: [
          "Remote images off by default",
          "Load them per message when you want",
          "No third-party scripts in the webmail",
        ],
        bloom: "green",
        art: <TrackerBlocked />,
      },
      {
        icon: HistoryIcon,
        label: "Nothing hidden",
        title: "If our staff touch your account, you see it.",
        body: "Support tools never show mail content. Any staff action on your account is written to its activity log, which account admins can read.",
        bullets: ["Activity log for every change", "Staff actions labelled as staff", "Mail content never in logs"],
        bloom: "blue",
        art: <AuditMock />,
      },
    ],
    detailsTitle: "Your mail, on your terms",
    details: [
      {
        icon: ShieldCheckIcon,
        title: "No ads, ever",
        body: "Paid plans fund the service. There is no ad business to feed.",
      },
      {
        icon: DownloadIcon,
        title: "Export anytime",
        body: "Take every message and contact with you in standard formats.",
      },
      { icon: TrashIcon, title: "Delete for real", body: "Close your account and your mail is deleted, not archived." },
      { icon: CodeIcon, title: "Open source", body: "Don’t take our word for it — the code is public." },
    ],
    faq: [
      {
        q: "Do you read my mail?",
        a: (
          <>
            No. See the <Link href="/legal/privacy">Privacy Policy</Link> for exactly what we store and why.
          </>
        ),
      },
      {
        q: "Is it end-to-end encrypted?",
        a: "No, and we won’t pretend it is. Mail is encrypted in transit, and we never sell or mine it.",
      },
    ],
    related: ["aliases", "webmail"],
  },
  apps: {
    eyebrow: "Mail apps",
    title: "Keep the apps you already like",
    lead: `${PROTOCOL_LIST} work with any standard mail app, on every device. App passwords keep your main password out of them.`,
    description: `Use AnhourMail in any mail app: ${PROTOCOL_LIST}, app passwords and automatic setup.`,
    heroArt: <SettingsCard />,
    rows: [
      {
        icon: PlugIcon,
        label: "Standard protocols",
        title: "Every app, every device.",
        body: "Thunderbird, Apple Mail on Mac, iPhone and iPad, Outlook, FairEmail and K-9 Mail on Android — if it speaks standard mail, it works.",
        bullets: [
          "Encrypted connections only",
          "Automatic setup where apps support it",
          "Server-side filters work everywhere",
        ],
        bloom: "blue",
        art: <SettingsCard />,
      },
      {
        icon: KeyRoundIcon,
        label: "App passwords",
        title: "A separate password for each app.",
        body: "Mail apps sign in with app passwords you create and revoke one at a time. Lose a phone? Revoke its password — nothing else changes.",
        bullets: [
          "One per device or app",
          "Revoke instantly",
          "Your main password and two-step sign-in stay protected",
        ],
        bloom: "violet",
        art: <AliasToggles />,
      },
    ],
    detailsTitle: "Set up in minutes",
    details: [
      { icon: WandIcon, title: "Autoconfig", body: "Many apps fill in the server settings from your address." },
      {
        icon: MonitorSmartphoneIcon,
        title: "Every platform",
        body: "Desktop, phone and tablet — use as many as you like.",
      },
      { icon: RefreshCwIcon, title: "Push mail", body: "New mail shows up on your devices as it arrives." },
      { icon: GlobeIcon, title: "Your domain too", body: "Custom domains work in every app exactly the same way." },
    ],
    faq: [
      {
        q: "Where are the exact settings?",
        a: (
          <>
            On the <Link href="/docs/clients/imap-smtp-settings">mail app settings</Link> page, with copy buttons.
          </>
        ),
      },
    ],
    related: ["webmail", "custom-domains"],
  },
};
