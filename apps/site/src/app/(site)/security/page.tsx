// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import {
  CodeIcon,
  DownloadIcon,
  EyeOffIcon,
  FileSearchIcon,
  HistoryIcon,
  ImageOffIcon,
  KeyRoundIcon,
  LockIcon,
  ScaleIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { PRODUCT_DOMAIN } from "@anhourmail/shared";

import { AliasToggles, TrackerBlocked } from "@/components/landing/illustrations";
import { CtaBand, EssentialsGrid, FeatureRow, PageHero, Prose, SectionHead } from "@/components/sections";

export const metadata: Metadata = {
  title: "Privacy and security",
  description:
    "How AnhourMail protects your account and your mail: open source, no tracking, encryption in transit, two-step sign-in, app passwords and a visible activity log.",
  alternates: { canonical: "/security" },
  openGraph: { title: "Privacy and security · AnhourMail", url: "/security" },
};

const PRACTICES = [
  {
    icon: CodeIcon,
    title: "Open source",
    body: "The webmail, console and site are public. Anyone can check how they work.",
  },
  { icon: EyeOffIcon, title: "No tracking", body: "No ads, no analytics, no third-party scripts in the product." },
  { icon: ImageOffIcon, title: "Remote images blocked", body: "Senders can’t see when you open their mail." },
  {
    icon: LockIcon,
    title: "Encrypted in transit",
    body: "Every connection to your mail uses TLS. Encryption at rest for stored mail is on the roadmap.",
  },
  { icon: ShieldCheckIcon, title: "Two-step sign-in", body: "Protect the console with an authenticator app." },
  { icon: KeyRoundIcon, title: "App passwords", body: "Each mail app gets its own password you can revoke." },
  { icon: HistoryIcon, title: "Activity log", body: "Account admins see every change, including any staff action." },
  {
    icon: DownloadIcon,
    title: "Export anytime",
    body: "Your mail and contacts, in standard formats, whenever you want.",
  },
] as const;

export default function SecurityPage() {
  return (
    <>
      <PageHero
        title="Built so we can’t make money from your mail"
        lead="No ad business, nothing to sell. Sensible defaults, open code, and a record of everything that happens to your account."
        actions={false}
      />
      <section className="am-site-section">
        <div className="flex flex-col gap-12">
          <SectionHead title="How we protect your mail" />
          <EssentialsGrid items={PRACTICES} />
        </div>
      </section>
      <section className="am-site-section pt-0">
        <div className="am-site-wrap-wide flex flex-col gap-28 sm:gap-36">
          <FeatureRow
            icon={ImageOffIcon}
            label="Safe rendering"
            title="Mail can’t run code or watch you."
            body="Messages are cleaned before they’re shown and rendered in an isolated frame with scripts off. Remote content waits for your permission."
            bullets={["Sanitised HTML", "Scripts never run", "Tracking pixels stopped"]}
            bloom="green"
            art={<TrackerBlocked />}
          />
          <FeatureRow
            icon={KeyRoundIcon}
            label="Account security"
            title="One leaked password shouldn’t cost you everything."
            body="Two-step sign-in protects the console. Mail apps get their own app passwords, so a lost phone is one revoke away from safe."
            bullets={["Authenticator app support", "Per-app passwords", "Sign out everywhere"]}
            bloom="violet"
            art={<AliasToggles />}
            flip
          />
        </div>
      </section>
      <section className="am-site-section pt-0">
        <div className="am-site-wrap grid grid-cols-[minmax(0,1fr)] gap-12 md:grid-cols-2">
          <div className="flex flex-col gap-4">
            <FileSearchIcon className="size-6 text-[rgb(var(--am-btn))]" aria-hidden="true" />
            <h2 className="am-site-h3">Transparency report</h2>
            <Prose>
              <p>
                We will publish a regular report counting the requests for user data we receive and how we answered
                them. The first one comes after launch.
              </p>
            </Prose>
          </div>
          <div className="flex flex-col gap-4">
            <ScaleIcon className="size-6 text-[rgb(var(--am-btn))]" aria-hidden="true" />
            <h2 className="am-site-h3">Found a vulnerability?</h2>
            <Prose>
              <p>
                Please tell us privately at <a href={`mailto:security@${PRODUCT_DOMAIN}`}>security@{PRODUCT_DOMAIN}</a>{" "}
                before sharing it. Our disclosure policy is in the repository’s SECURITY.md. The full{" "}
                <Link href="/legal/privacy">Privacy Policy</Link> covers what we store and why.
              </p>
            </Prose>
          </div>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
