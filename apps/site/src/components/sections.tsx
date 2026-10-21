// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Building blocks shared by every marketing page, so the site keeps one visual and motion language
 * (BookYourPTO pattern): page hero, section heads, alternating feature rows, the essentials grid, plan cards,
 * FAQ and the closing waitlist band. No pill clouds, no floating callouts (docs/internal/branding.md).
 */
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";

import {
  ArrowRightIcon,
  BanIcon,
  CheckIcon,
  CodeIcon,
  DownloadIcon,
  EyeOffIcon,
  GlobeIcon,
  ImageOffIcon,
  MailIcon,
  PlugIcon,
  PlusIcon,
  VenetianMaskIcon,
} from "lucide-react";

import { ADDONS, BILLING, formatPrice, PLAN_ORDER, PLANS, PRODUCT_DOMAIN } from "@anhourmail/shared";
import { Breadcrumbs, type Crumb } from "@anhourmail/ui/page-header";

import { PROTOCOL_LIST } from "@/lib/ia";

import { Reveal } from "./reveal";
import { WaitlistForm } from "./waitlist-form";

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;

/** Dark sky hero for inner pages: shorter than the home hero, same atmosphere. */
export function PageHero({
  crumbs = [],
  title,
  lead,
  actions = true,
  children,
}: {
  /** Breadcrumb trail; rendered only at two or more levels (branding.md: no eyebrow kickers on pages). */
  crumbs?: Crumb[];
  title: ReactNode;
  lead: ReactNode;
  actions?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="am-site-hero am-site-under-nav">
      <div aria-hidden="true" className="am-site-sky-clip">
        <div className="am-site-sky">
          <span className="am-site-sky-blob am-site-sky-blob--a" />
          <span className="am-site-sky-blob am-site-sky-blob--b" />
        </div>
        <div className="am-site-sky-scrim" />
        <div className="am-site-sky-grain" />
      </div>
      <div
        className={`relative flex flex-col items-center px-5 pt-[132px] text-center sm:pt-[150px] ${children ? "" : "pb-20 sm:pb-24"}`}
      >
        {crumbs.length >= 2 ? (
          <Reveal onLoad className="am-site-crumbs-on-dark mb-6">
            <Breadcrumbs items={crumbs} />
          </Reveal>
        ) : null}
        <Reveal onLoad delayMs={120}>
          <h1 className="am-site-hero-h1 max-w-[17ch] text-[clamp(2.25rem,1.3rem+3.8vw,3.75rem)]">{title}</h1>
        </Reveal>
        <Reveal onLoad delayMs={240}>
          <div className="mx-auto mt-5 max-w-[52ch] text-[clamp(1rem,0.95rem+0.3vw,1.125rem)] text-white/75 leading-relaxed">
            {lead}
          </div>
        </Reveal>
        {actions ? (
          <Reveal
            onLoad
            delayMs={360}
            className="mt-8 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row"
          >
            <Link href="#waitlist" className="am-site-btn am-site-btn--primary h-[50px] w-full px-6 sm:w-auto">
              Join the waitlist
              <ArrowRightIcon className="size-4" aria-hidden="true" />
            </Link>
            <Link href="/pricing" className="am-site-btn am-site-btn--glass h-[50px] w-full px-6 sm:w-auto">
              See pricing
            </Link>
          </Reveal>
        ) : null}
      </div>
      {children ? (
        <div className="relative z-20 mt-12 -mb-[120px] px-4 sm:-mb-[160px]">
          <Reveal onLoad delayMs={480} variant="scale" className="mx-auto w-full max-w-[880px]">
            {children}
          </Reveal>
        </div>
      ) : null}
    </section>
  );
}

/** Spacer panel that takes the hero art's overlap (pair with PageHero children). */
export function Seam({ children, tall = true }: { children?: ReactNode; tall?: boolean }) {
  return (
    <section className={`am-site-seam px-5 pb-6 ${tall ? "pt-[170px] sm:pt-[210px]" : "pt-12"}`}>{children}</section>
  );
}

export function SectionHead({
  kicker,
  title,
  lead,
  align = "center",
}: {
  /** Rare: only when it adds information (e.g. a status). Never a generic section label. */
  kicker?: string;
  title: ReactNode;
  lead?: ReactNode;
  align?: "center" | "left";
}) {
  return (
    <Reveal
      className={`flex max-w-[44rem] flex-col gap-4 ${align === "center" ? "mx-auto items-center text-center" : "items-start"}`}
    >
      {kicker ? <span className="am-eyebrow">{kicker}</span> : null}
      <h2 className="am-site-h2">{title}</h2>
      {lead ? <p className="am-site-lead">{lead}</p> : null}
    </Reveal>
  );
}

/** Text + illustration on a tinted stage; `flip` puts the art first on large screens. */
export function FeatureRow({
  icon: IconCmp,
  label,
  title,
  body,
  bullets,
  bloom,
  art,
  flip = false,
  href,
}: {
  icon: Icon;
  label: string;
  title: string;
  body: string;
  bullets: readonly string[];
  bloom: "blue" | "cyan" | "green" | "amber" | "violet";
  art: ReactNode;
  flip?: boolean;
  href?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-10 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)] lg:gap-16">
      <Reveal className={`flex min-w-0 flex-col gap-5 ${flip ? "lg:order-2" : ""}`}>
        <span
          className="inline-flex size-11 items-center justify-center rounded-xl bg-[rgb(var(--am-btn)/0.1)] text-[rgb(var(--am-btn))] dark:text-[rgb(var(--am-cyan-hi))]"
          title={label}
        >
          <IconCmp className="size-5" aria-hidden="true" />
        </span>
        <h3 className="am-site-h2 max-w-[17ch]">{title}</h3>
        <p className="am-site-lead max-w-[46ch]">{body}</p>
        <ul className="flex flex-col gap-2.5">
          {bullets.map((b) => (
            <li key={b} className="flex items-center gap-3 text-[15px]">
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--am-btn))] text-white">
                <CheckIcon className="size-3" strokeWidth={3} aria-hidden="true" />
              </span>
              {b}
            </li>
          ))}
        </ul>
        {href ? (
          <Link href={href} className="am-site-link-arrow mt-1">
            Learn more
            <span className="sr-only"> about {typeof title === "string" ? title : "this feature"}</span>
            <ArrowRightIcon className="size-4" aria-hidden="true" />
          </Link>
        ) : null}
      </Reveal>
      <Reveal variant="scale" delayMs={120} className={`am-site-bloom am-site-bloom--${bloom} min-w-0`}>
        {art}
      </Reveal>
    </div>
  );
}

export const ESSENTIALS: readonly { icon: Icon; title: string; body: string }[] = [
  { icon: BanIcon, title: "No ads", body: "Nothing in your inbox is there to sell you something." },
  { icon: EyeOffIcon, title: "No tracking pixels", body: "Senders can’t tell when or where you opened their mail." },
  { icon: ImageOffIcon, title: "Remote images off", body: "Images load only when you say so, one message at a time." },
  { icon: GlobeIcon, title: "Your own domain", body: "Bring the address you already own, with guided DNS checks." },
  {
    icon: VenetianMaskIcon,
    title: "Masked aliases",
    body: "A fresh address for every sign-up, switched off in a click.",
  },
  { icon: PlugIcon, title: "Every mail app", body: `${PROTOCOL_LIST}, so the apps you like keep working.` },
  {
    icon: DownloadIcon,
    title: "Export anytime",
    body: "All your mail and contacts, in standard formats, whenever you want.",
  },
  { icon: CodeIcon, title: "Open source", body: "Read the code, report issues, or run it yourself." },
];

/** Editorial grid: icon in a soft square, a title, one sentence; hairline separators, no cards, no pills. */
export function EssentialsGrid({
  items = ESSENTIALS,
}: {
  items?: readonly { icon: Icon; title: string; body: string }[];
}) {
  return (
    <ul className="am-site-wrap-wide grid grid-cols-1 border-t sm:grid-cols-2 lg:grid-cols-4">
      {items.map((e, i) => (
        <Reveal as="li" key={e.title} delayMs={(i % 4) * 90} className="am-site-essential">
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-[rgb(var(--am-btn)/0.1)] text-[rgb(var(--am-btn))] dark:text-[rgb(var(--am-cyan-hi))]">
            <e.icon className="size-5" aria-hidden="true" />
          </span>
          <h3 className="am-site-h4 mt-4">{e.title}</h3>
          <p className="mt-1.5 text-muted-foreground text-sm leading-relaxed">{e.body}</p>
        </Reveal>
      ))}
    </ul>
  );
}

export function PlanCards() {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-3">
        {PLAN_ORDER.map((id, i) => {
          const p = PLANS[id];
          const featured = id === "plus";
          return (
            <Reveal
              key={id}
              delayMs={i * 100}
              className={`am-site-card flex flex-col gap-5 bg-card p-7 ${featured ? "am-site-plan--featured" : ""}`}
            >
              <div className="flex items-center justify-between">
                <h3 className="am-site-h4">{p.name}</h3>
                {featured ? <span className="am-site-chip">Most people</span> : null}
              </div>
              <p className="min-h-[2.5rem] text-muted-foreground text-sm">{p.tagline}</p>
              <p className="am-site-h2">
                {p.price ? (
                  <>
                    <span className="text-base text-muted-foreground">{p.payWhatYouWant ? "from " : ""}</span>
                    {formatPrice(p.price.USD, "USD")}
                    <span className="text-base text-muted-foreground"> / {BILLING.interval}</span>
                  </>
                ) : (
                  "Free"
                )}
              </p>
              <p className="am-small -mt-3">
                {p.price
                  ? `or ${formatPrice(p.price.CAD, "CAD")} CAD per ${BILLING.interval}`
                  : "Invite-only while we grow"}
              </p>
              <ul className="flex flex-col gap-2.5 border-t pt-5 text-sm">
                {[
                  `${p.storageGb} GB storage`,
                  p.customDomains ? "Bring your own domains" : `An @${PRODUCT_DOMAIN} address`,
                  p.aliases === null ? "Unlimited aliases" : `${p.aliases} aliases`,
                  p.maskedAliases === null ? "Unlimited masked aliases" : `${p.maskedAliases} masked aliases`,
                  ...(p.catchAll ? ["Catch-all addresses"] : []),
                  ...(p.supporterBadge ? ["Supporter badge and early features"] : []),
                ].map((line) => (
                  <li key={line} className="flex items-center gap-2.5">
                    <PlusIcon className="size-3.5 text-[rgb(var(--am-btn))]" aria-hidden="true" />
                    {line}
                  </li>
                ))}
              </ul>
            </Reveal>
          );
        })}
      </div>
      <Reveal className="am-site-card flex flex-col gap-4 bg-card p-7 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-[rgb(var(--am-btn)/0.1)] text-[rgb(var(--am-btn))] dark:text-[rgb(var(--am-cyan-hi))]">
            <MailIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1">
            <h3 className="am-site-h4">
              {ADDONS.bulk.name} <span className="text-base text-muted-foreground">· add-on</span>
            </h3>
            <p className="max-w-[60ch] text-muted-foreground text-sm">
              {ADDONS.bulk.tagline} For {ADDONS.bulk.requires.map((id) => PLANS[id].name).join(" and ")} plans.
            </p>
          </div>
        </div>
        <span className="shrink-0 font-medium text-muted-foreground text-sm">
          {ADDONS.bulk.status === "planned" ? "Coming later" : "Available"}
        </span>
      </Reveal>
    </div>
  );
}

export function FaqList({ items }: { items: readonly { q: string; a: ReactNode }[] }) {
  return (
    <Reveal className="flex flex-col gap-3">
      {items.map((f) => (
        <details key={f.q} className="am-site-faq am-site-card group bg-card p-0">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5">
            <span className="am-site-h4">{f.q}</span>
            <PlusIcon className="am-site-faq-chevron size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </summary>
          <div className="max-w-[62ch] px-6 pb-6 text-muted-foreground">{f.a}</div>
        </details>
      ))}
    </Reveal>
  );
}

/** Closing waitlist band; flows straight into the dark footer. */
export function CtaBand({ id = "waitlist", title = "Get your inbox back." }: { id?: string; title?: string }) {
  return (
    <section id={id} className="am-site-night-fade relative mt-[var(--am-site-pad-y)] overflow-hidden">
      <div aria-hidden="true" className="am-site-sky opacity-60">
        <span className="am-site-sky-blob am-site-sky-blob--b" />
        <span className="am-site-sky-blob am-site-sky-blob--c" />
      </div>
      <div className="am-site-wrap relative flex flex-col items-center gap-6 py-28 text-center">
        <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/15">
          <MailIcon className="size-6" aria-hidden="true" />
        </span>
        <h2 className="am-site-h2 max-w-[18ch]">{title}</h2>
        <p className="max-w-[46ch] text-white/75">
          We’ll invite people in small groups. One email when your invite is ready, nothing else.
        </p>
        <WaitlistForm />
      </div>
    </section>
  );
}

/** Generic prose block for long-form sections (about, switch, security). */
export function Prose({ children }: { children: ReactNode }) {
  return <div className="am-site-legal max-w-[68ch]">{children}</div>;
}
