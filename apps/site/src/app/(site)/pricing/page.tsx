// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { CheckIcon, MinusIcon } from "lucide-react";

import {
  ADDONS,
  BILLING,
  fairUseText,
  formatPrice,
  MAX_MAILBOXES,
  PLAN_ORDER,
  PLANS,
  PRODUCT_DOMAIN,
  type Plan,
} from "@anhourmail/shared";

import { Reveal } from "@/components/reveal";
import { CtaBand, FaqList, PageHero, PlanCards, SectionHead } from "@/components/sections";

export const metadata: Metadata = {
  title: "Pricing",
  description: `AnhourMail plans: a free address, paid plans billed once a ${BILLING.interval} with a ${String(BILLING.refundWindowDays)}-day refund window.`,
  alternates: { canonical: "/pricing" },
  openGraph: { title: "Pricing · AnhourMail", url: "/pricing" },
};

type RowValue = string | boolean;
const ROWS: readonly { label: string; value: (p: Plan) => RowValue }[] = [
  { label: "Storage per mailbox", value: (p) => `${String(p.storageGb)} GB` },
  {
    label: "Mailboxes included",
    value: (p) =>
      p.extraMailboxPrice
        ? `${String(p.includedMailboxes)}, then ${formatPrice(p.extraMailboxPrice.USD, "USD")}/${BILLING.interval} each`
        : String(p.includedMailboxes),
  },
  {
    label: "Storage per account",
    value: (p) =>
      p.fairUseStorageGb === null || p.extraStoragePricePerGb === null
        ? `${String(p.storageGb)} GB`
        : `Fair use ${String(p.fairUseStorageGb)} GB, then ${formatPrice(p.extraStoragePricePerGb.USD, "USD")}/GB/${BILLING.interval}`,
  },
  // Free: its own allowance; paid plans: as many as their mailboxes (ADR-0021).
  {
    label: `@${PRODUCT_DOMAIN} addresses`,
    value: (p) => (p.platformMailboxes === null ? `Up to ${String(MAX_MAILBOXES)}` : String(p.platformMailboxes)),
  },
  { label: "Your own domains", value: (p) => p.customDomains },
  { label: "Aliases", value: (p) => (p.aliases === null ? "Unlimited" : String(p.aliases)) },
  { label: "Masked aliases", value: (p) => (p.maskedAliases === null ? "Unlimited" : String(p.maskedAliases)) },
  { label: "Catch-all", value: (p) => p.catchAll },
  { label: "Webmail and every mail app", value: () => true },
  { label: "Export anytime", value: () => true },
  { label: "Supporter badge and early features", value: (p) => p.supporterBadge },
];

function Cell({ v }: { v: RowValue }) {
  if (v === true) return <CheckIcon className="mx-auto size-4 text-[rgb(var(--am-btn))]" aria-label="Included" />;
  if (v === false) return <MinusIcon className="mx-auto size-4 text-muted-foreground" aria-label="Not included" />;
  return <span>{v}</span>;
}

const FAQ = [
  {
    q: "How does billing work?",
    a: `Paid plans are billed once a ${BILLING.interval} in ${BILLING.currencies.join(" or ")}. They renew automatically, we remind you before they do, and you can cancel any time.`,
  },
  {
    q: "Can I get a refund?",
    a: `Yes — ask within ${String(BILLING.refundWindowDays)} days of a payment and we refund it in full.`,
  },
  {
    q: "Is there a free trial?",
    a: "The free plan is the trial. Paid plans don’t have one, so there’s nothing to remember to cancel.",
  },
  { q: "Do prices include tax?", a: "No. Sales tax is added at checkout where it applies." },
  {
    q: "Is there a storage limit on paid plans?",
    a: `No hard limit on the account. Each mailbox holds up to ${String(PLANS.plus.storageGb)} GB, and an account can store ${String(PLANS.plus.fairUseStorageGb)} GB in total under fair use; storage beyond that is ${PLANS.plus.extraStoragePricePerGb ? formatPrice(PLANS.plus.extraStoragePricePerGb.USD, "USD") : ""} per GB per ${BILLING.interval}. We let you know before anything is charged.`,
  },
  {
    q: `Can I have more than ${String(PLANS.plus.includedMailboxes)} mailboxes?`,
    a: `Paid plans include ${String(PLANS.plus.includedMailboxes)}. Extra mailboxes will be ${PLANS.plus.extraMailboxPrice ? formatPrice(PLANS.plus.extraMailboxPrice.USD, "USD") : ""} per ${BILLING.interval} each once billing opens; until then an account can have up to ${String(MAX_MAILBOXES)}.`,
  },
  {
    q: "What happens if a payment fails?",
    a: "We retry and let you know. If it still fails, the account moves to the free plan’s limits. Your mail is never deleted because a payment failed.",
  },
  {
    q: `What is ${ADDONS.bulk.name}?`,
    a: `${ADDONS.bulk.tagline} It’s a planned add-on for ${ADDONS.bulk.requires.map((id) => PLANS[id].name).join(" and ")} plans; the standard plans are for personal mail.`,
  },
  {
    q: "Where are the full terms?",
    a: (
      <>
        In the <Link href="/legal/terms">Terms of Service</Link> (draft, under legal review).
      </>
    ),
  },
] as const;

export default function PricingPage() {
  return (
    <>
      <PageHero
        title="Simple yearly pricing"
        lead={`Start free. Upgrade when you want your own domain and more room. Billed once a ${BILLING.interval}, with a ${String(BILLING.refundWindowDays)}-day refund window.`}
        actions={false}
      />
      <section className="am-site-section">
        <div className="am-site-wrap-wide flex flex-col gap-6">
          <Reveal>
            <p className="am-small text-center">Planned pricing — final prices are confirmed before the beta opens.</p>
          </Reveal>
          <h2 className="sr-only">Plans</h2>
          <PlanCards />
          {fairUseText(PLANS.plus) && (
            <Reveal>
              <p className="am-small text-center">
                {PLANS.plus.name} and {PLANS.supporter.name}: {fairUseText(PLANS.plus)}.
              </p>
            </Reveal>
          )}
        </div>
      </section>
      <section className="am-site-section pt-0">
        <div className="am-site-wrap-wide flex flex-col gap-10">
          <SectionHead title="Compare plans" />
          <Reveal className="overflow-x-auto rounded-[20px] border">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th scope="col" className="px-5 py-4 text-left font-medium">
                    <span className="sr-only">Feature</span>
                  </th>
                  {PLAN_ORDER.map((id) => (
                    <th key={id} scope="col" className="px-5 py-4 text-center font-display font-medium text-base">
                      {PLANS[id].name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {ROWS.map((r) => (
                  <tr key={r.label}>
                    <th scope="row" className="px-5 py-3.5 text-left font-normal text-muted-foreground">
                      {r.label}
                    </th>
                    {PLAN_ORDER.map((id) => (
                      <td key={id} className="px-5 py-3.5 text-center">
                        <Cell v={r.value(PLANS[id])} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Reveal>
        </div>
      </section>
      <section className="am-site-section pt-0">
        <div className="am-site-wrap flex flex-col gap-10">
          <SectionHead title="Billing questions" />
          <FaqList items={FAQ} />
        </div>
      </section>
      <CtaBand />
    </>
  );
}
