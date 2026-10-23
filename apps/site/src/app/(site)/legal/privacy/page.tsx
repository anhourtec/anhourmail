// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { BRAND } from "@anhourmail/shared";

import { type LegalSection, LegalPage } from "@/components/legal/legal-page";
import { LEGAL_CONTACTS } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${BRAND.company} handles personal information for ${BRAND.product}. Draft under legal review.`,
  alternates: { canonical: "/legal/privacy" },
};

const privacy = <a href={`mailto:${LEGAL_CONTACTS.privacy}`}>{LEGAL_CONTACTS.privacy}</a>;

const SECTIONS: LegalSection[] = [
  {
    id: "who",
    title: "Who is responsible",
    body: (
      <p>
        {BRAND.company}, based in {BRAND.location}, runs {BRAND.product} and is responsible for the personal information
        described here. We follow British Columbia’s Personal Information Protection Act (PIPA) and, for information
        that crosses provincial or national borders, the federal PIPEDA. Our privacy officer can be reached at {privacy}
        .
      </p>
    ),
  },
  {
    id: "collect",
    title: "What we collect",
    body: (
      <ul>
        <li>
          <strong>Account details:</strong> your name, sign-in email, a hashed password, two-step sign-in settings and
          your role in any shared account.
        </li>
        <li>
          <strong>Your mail:</strong> the messages, contacts and settings you store. We hold them to deliver and show
          them to you — that’s all.
        </li>
        <li>
          <strong>Billing:</strong> plan, payment status and invoices. Card details go straight to our payment
          processor; we never see or store the full card number.
        </li>
        <li>
          <strong>Security and delivery records:</strong> sign-in events (time, IP address, device), an activity log of
          changes to your account, and mail delivery metadata (message ID, sending and receiving domains, status) for
          troubleshooting. These never contain message subjects, bodies or attachments.
        </li>
      </ul>
    ),
  },
  {
    id: "never",
    title: "What we never do",
    body: (
      <ul>
        <li>No ads, and no profiling for advertising.</li>
        <li>We don’t sell, rent or trade personal information.</li>
        <li>
          No tracking pixels or third-party analytics — in the webmail or on this site. This site sets no cookies.
        </li>
        <li>Mail content never goes into our logs, analytics or error reports.</li>
        <li>
          Staff support tools don’t show mail content, and any staff action on your account shows in your account’s
          activity log.
        </li>
      </ul>
    ),
  },
  {
    id: "use",
    title: "How we use it",
    body: (
      <ul>
        <li>To run the service: store and deliver mail, sign you in, and keep your account secure.</li>
        <li>To bill paid plans and keep the records tax law requires.</li>
        <li>
          To prevent abuse: we use sending volumes, bounces and complaints — not message content — to stop spam (see the{" "}
          <Link href="/legal/acceptable-use">Acceptable Use Policy</Link>).
        </li>
        <li>
          To contact you about your account, security and changes to these policies. Product news only if you opt in.
        </li>
      </ul>
    ),
  },
  {
    id: "processors",
    title: "Service providers",
    body: (
      <>
        <p>
          We use a small number of providers to run {BRAND.product}, each under a contract that limits what they can do
          with the information. Some are outside Canada, so information they handle may be processed in another country
          and be accessible to that country’s authorities under its laws.
        </p>
        <ul>
          <li>
            <strong>Payments:</strong> Stripe (United States) — billing details for paid plans only. Never mailbox data.
          </li>
          <li>
            <strong>Breached-password check:</strong> Have I Been Pwned’s Pwned Passwords service — when you choose a
            new password, our server sends only the first five characters of a one-way (SHA-1) hash of it and compares
            the answer itself. Your password, its full hash, your address and your IP address are never sent.
          </li>
          <li>The full list of providers, with what each receives and where, will be published here before launch.</li>
        </ul>
      </>
    ),
  },
  {
    id: "retention",
    title: "How long we keep it",
    body: (
      <ul>
        <li>Your mail, contacts and settings: until you delete them or close your account.</li>
        <li>Mail delivery metadata: 30 days.</li>
        <li>Sign-in history: 1 year.</li>
        <li>Your account’s activity log: the life of the account plus 1 year.</li>
        <li>Billing records: as long as tax law requires.</li>
      </ul>
    ),
  },
  {
    id: "rights",
    title: "Your rights",
    body: (
      <ul>
        <li>
          <strong>Access:</strong> ask what we hold about you and get a copy. We answer within 30 days.
        </li>
        <li>
          <strong>Export:</strong> download all of your mail and contacts yourself, at any time, in standard formats.
        </li>
        <li>
          <strong>Correction:</strong> fix your details in the console or ask us to.
        </li>
        <li>
          <strong>Deletion:</strong> close your account and we delete your mail, contacts and settings, keeping only
          what the law requires.
        </li>
        <li>
          <strong>Complaints:</strong> contact {privacy} first. You can also complain to the Office of the Information
          and Privacy Commissioner for British Columbia or the Office of the Privacy Commissioner of Canada.
        </li>
      </ul>
    ),
  },
  {
    id: "security",
    title: "Security and breaches",
    body: (
      <p>
        Mail is encrypted in transit, accounts support two-step sign-in and app passwords, and staff access is limited
        and logged. {BRAND.product} isn’t end-to-end encrypted, and we don’t claim it is. If a breach creates a real
        risk of significant harm to you, we notify you and the Privacy Commissioner as soon as we can, and we keep a
        record of every breach.
      </p>
    ),
  },
  {
    id: "requests",
    title: "Requests from authorities",
    body: (
      <p>
        We hand over information only when Canadian law requires it, such as a court order, and we push back on requests
        that are too broad. Foreign authorities must go through the legal channels between their country and Canada.
        Where the law allows, we tell you before we disclose anything. We will publish a regular transparency report
        counting the requests we receive and how we answered them.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes and contact",
    body: (
      <p>
        If we change this policy in a way that matters, we’ll email account holders before it takes effect. Questions or
        requests: {privacy}.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      lead={
        <p>
          The short version: we hold your mail so we can deliver it, we never read it to sell anything, and you can take
          it with you whenever you like.
        </p>
      }
      sections={SECTIONS}
    />
  );
}
