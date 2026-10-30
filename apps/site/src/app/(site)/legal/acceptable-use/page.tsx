// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { ADDONS, BRAND, BULK_MAIL, PLANS } from "@anhourmail/shared";

import { type LegalSection, LegalPage } from "@/components/legal/legal-page";
import { LEGAL_CONTACTS } from "@/lib/legal";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Acceptable Use Policy",
  description: `What you can't do with ${BRAND.product}, and how we enforce it. Draft under legal review.`,
  path: "/legal/acceptable-use",
});

const abuse = <a href={`mailto:${LEGAL_CONTACTS.abuse}`}>{LEGAL_CONTACTS.abuse}</a>;

const SECTIONS: LegalSection[] = [
  {
    id: "why",
    title: "Why this matters",
    body: (
      <p>
        Every account shares the same reputation with the big mail providers. One spammer can get everyone’s mail sent
        to junk. These rules keep {BRAND.product} deliverable for the people who use it properly — which is almost
        everyone.
      </p>
    ),
  },
  {
    id: "bulk",
    title: "Bulk and marketing mail",
    body: (
      <>
        {/* BULK_MAIL.allowedOnBasePlans is false in @anhourmail/shared */}
        <p>
          The standard plans are for personal mail. Bulk, newsletter and marketing mail are not allowed on them. That
          includes:
        </p>
        <ul>
          <li>Newsletters and announcements to lists, even lists that opted in.</li>
          <li>Sending to bought, rented or scraped lists — never allowed, add-on or not.</li>
          <li>
            Splitting sends across accounts or aliases to get around the{" "}
            <Link href="/docs/sending-limits">sending limits</Link>.
          </li>
        </ul>
        <p>
          <strong>{ADDONS[BULK_MAIL.addOnId].name}</strong> will be a paid add-on
          {ADDONS[BULK_MAIL.addOnId].status === "planned" ? " (coming later)" : ""} for{" "}
          {ADDONS[BULK_MAIL.addOnId].requires.map((id) => PLANS[id].name).join(" and ")} accounts. It sends from a
          separate pool, and only under these conditions, which follow Canada’s anti-spam law (CASL):
        </p>
        <ul>
          <li>Every recipient opted in, and you keep a record of when and how they consented.</li>
          <li>Every message clearly identifies who sent it, with working contact details.</li>
          <li>Every message has a one-click unsubscribe, honoured right away.</li>
        </ul>
      </>
    ),
  },
  {
    id: "harm",
    title: "Nothing harmful or illegal",
    body: (
      <ul>
        <li>No spam, phishing, scams or fraud.</li>
        <li>No malware, or links to it.</li>
        <li>No harassment, threats or abuse.</li>
        <li>No impersonating people or organisations, or forging message headers.</li>
        <li>No content that is illegal where you or the recipient are, including child sexual abuse material.</li>
      </ul>
    ),
  },
  {
    id: "system",
    title: "No misusing the service",
    body: (
      <ul>
        <li>No harvesting addresses or verifying lists.</li>
        <li>No relaying mail for another service, or running an open relay through your account.</li>
        <li>No automated account creation, and no reselling accounts.</li>
        <li>No attempts to break, overload or get around our security and limits.</li>
      </ul>
    ),
  },
  {
    id: "enforcement",
    title: "How we enforce it",
    body: (
      <>
        <p>
          We look at sending patterns — volumes, bounces and complaints — and at messages people report to us. Staff
          don’t read your mailbox to investigate. Depending on how serious it is, we:
        </p>
        <ul>
          <li>
            <strong>Slow sending down</strong> when an account suddenly sends far more than usual.
          </li>
          <li>
            <strong>Pause sending</strong> while we review. Receiving mail keeps working, and the console tells you what
            happened.
          </li>
          <li>
            <strong>Suspend</strong> the account if the problem is confirmed. You can still export your mail for 30 days
            unless the law forbids it.
          </li>
          <li>
            <strong>Close</strong> the account for serious or repeated abuse. We report illegal content as the law
            requires.
          </li>
        </ul>
        <p>We tell you why we acted unless the law stops us, and you can ask for a review.</p>
      </>
    ),
  },
  {
    id: "report",
    title: "Reporting abuse",
    body: (
      <p>
        If you get spam, phishing or anything abusive from an {BRAND.product} address, forward it with full headers to{" "}
        {abuse}. We read every report and aim to respond within one business day.
      </p>
    ),
  },
];

export default function AcceptableUsePage() {
  return (
    <LegalPage
      title="Acceptable Use Policy"
      lead={
        <p>
          The short version: send the mail a person would send. No spam, nothing harmful, and lists only through the
          bulk add-on.
        </p>
      }
      sections={SECTIONS}
    />
  );
}
