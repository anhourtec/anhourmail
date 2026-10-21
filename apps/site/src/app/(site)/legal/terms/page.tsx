// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { ADDONS, BILLING, BRAND, BULK_MAIL, formatPrice, PLAN_ORDER, PLANS, PRODUCT_DOMAIN } from "@anhourmail/shared";

import { type LegalSection, LegalPage } from "@/components/legal/legal-page";
import { LEGAL_CONTACTS } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: `The agreement between you and ${BRAND.company} for using ${BRAND.product}. Draft under legal review.`,
  alternates: { canonical: "/legal/terms" },
};

const paid = PLAN_ORDER.filter((id) => PLANS[id].price !== null);

const SECTIONS: LegalSection[] = [
  {
    id: "who",
    title: "Who we are",
    body: (
      <p>
        {BRAND.product} is run by {BRAND.company}, a company based in {BRAND.location}. “We” and “us” mean{" "}
        {BRAND.company}; “you” means the person who holds the account. If you use {BRAND.product} for a family or group
        account, the account Owner accepts these terms for everyone they add.
      </p>
    ),
  },
  {
    id: "service",
    title: "The service",
    body: (
      <>
        <p>
          {BRAND.product} hosts email: mailboxes, aliases and masked aliases, a webmail, and standard IMAP, SMTP and
          JMAP access for your own mail apps. The standard plans are for personal mail. Newsletters and bulk sending
          need the {ADDONS[BULK_MAIL.addOnId].name} add-on
          {ADDONS[BULK_MAIL.addOnId].status === "planned" ? ", which is coming later" : ""}.
        </p>
        <p>
          We work to keep the service available and your mail safe, but we can’t promise it will never be interrupted.
          Planned maintenance and incidents are announced on the status page.
        </p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts and eligibility",
    body: (
      <ul>
        <li>You need to be old enough to agree to these terms where you live, and at least 16.</li>
        <li>The free plan (an @{PRODUCT_DOMAIN} address) is limited to one free account per person.</li>
        <li>Keep your password and two-step sign-in safe. You’re responsible for what happens under your account.</li>
        <li>Don’t create accounts automatically or resell them.</li>
      </ul>
    ),
  },
  {
    id: "billing",
    title: "Plans, billing and refunds",
    body: (
      <>
        <p>
          Paid plans are billed once a {BILLING.interval}, in {BILLING.currencies.join(" or ")}, through our payment
          processor. Current plans:
        </p>
        <ul>
          {paid.map((id) => {
            const p = PLANS[id];
            if (!p.price) return null;
            return (
              <li key={id}>
                <strong>{p.name}</strong>: {p.payWhatYouWant ? "from " : ""}
                {formatPrice(p.price.USD, "USD")} USD or {formatPrice(p.price.CAD, "CAD")} CAD per {BILLING.interval}
                {p.payWhatYouWant ? ", pay what you want above that" : ""}.
              </li>
            );
          })}
        </ul>
        <p>
          Prices don’t include sales tax where it applies. Your plan renews automatically each {BILLING.interval}; we
          remind you before it does, and you can cancel any time so it doesn’t renew.
        </p>
        <p>
          <strong>
            Refunds: if you’re not happy, ask within {BILLING.refundWindowDays} days of a payment and we’ll refund it in
            full.
          </strong>{" "}
          After that, payments are not refundable except where the law says otherwise. Paid plans have no free trial —
          the free plan is the trial.
        </p>
        <p>
          If a renewal payment fails, we retry for a while and tell you. If it still fails, the account moves to the
          free plan’s limits; your mail is not deleted because a payment failed.
        </p>
      </>
    ),
  },
  {
    id: "use",
    title: "Acceptable use",
    body: (
      <p>
        You agree to follow the <Link href="/legal/acceptable-use">Acceptable Use Policy</Link>. In short: no spam, no
        bulk or marketing mail outside the bulk add-on, nothing illegal or harmful, and respect the published{" "}
        <Link href="/docs/sending-limits">sending limits</Link>. Breaking it can lead to restricted sending, suspension
        or closure, as that policy describes.
      </p>
    ),
  },
  {
    id: "your-data",
    title: "Your mail and your data",
    body: (
      <ul>
        <li>Your mail is yours. We don’t claim any rights to it beyond what we need to store and deliver it.</li>
        <li>
          We never read your mail to sell ads or profile you. How we handle personal information is in the{" "}
          <Link href="/legal/privacy">Privacy Policy</Link>.
        </li>
        <li>You can export all of your mail and contacts at any time, in standard formats, on every plan.</li>
        <li>Keep your own backups of anything you can’t afford to lose.</li>
      </ul>
    ),
  },
  {
    id: "domains",
    title: "Custom domains",
    body: (
      <p>
        On paid plans you can use domains you own or control. You’re responsible for keeping the domain registered and
        its DNS records correct. If a domain lapses or its records change, mail for it may stop arriving.
      </p>
    ),
  },
  {
    id: "ending",
    title: "Ending the service",
    body: (
      <>
        <p>
          <strong>You</strong> can delete your account at any time from the console. Mail, contacts and settings are
          then deleted; billing records are kept only as long as the law requires.
        </p>
        <p>
          <strong>We</strong> may restrict, suspend or close an account that breaks these terms or the Acceptable Use
          Policy, or to protect other users and our ability to deliver mail. Unless the law stops us, we tell you why
          and, when an account is suspended, give you time to export your mail.
        </p>
        <p>
          If we ever shut {BRAND.product} down, we’ll give at least 90 days’ notice, keep export working throughout, and
          refund unused time on paid plans.
        </p>
      </>
    ),
  },
  {
    id: "open-source",
    title: "Open source",
    body: (
      <p>
        {BRAND.product}’s apps are open source under the AGPL-3.0 licence, and its libraries under MIT. These terms
        cover the hosted service at {PRODUCT_DOMAIN}; the licences cover the code. The {BRAND.product} name and logo are
        trademarks and aren’t covered by the code licences.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Warranties and liability",
    body: (
      <>
        <p>
          The service is provided “as is”. To the extent the law allows, we don’t give warranties beyond those in these
          terms, and we aren’t liable for indirect or consequential losses, such as lost profits or lost data you could
          have exported.
        </p>
        <p>
          To the extent the law allows, our total liability to you is limited to what you paid us in the 12 months
          before the claim. Nothing in these terms limits rights you have under consumer protection law that can’t be
          limited by contract.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: (
      <p>
        If we change these terms in a way that matters, we’ll email account holders at least 30 days before the change
        takes effect and say what changed. If you don’t agree, you can export your mail and close your account, and
        we’ll refund unused time on a paid plan.
      </p>
    ),
  },
  {
    id: "law",
    title: "Governing law and contact",
    body: (
      <p>
        These terms are governed by the laws of British Columbia and the federal laws of Canada that apply there.
        Questions: <a href={`mailto:${LEGAL_CONTACTS.legal}`}>{LEGAL_CONTACTS.legal}</a>.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      lead={
        <p>
          The rules for using {BRAND.product}, written to be read. Where a plain sentence and a legal one would say the
          same thing, we use the plain one.
        </p>
      }
      sections={SECTIONS}
    />
  );
}
