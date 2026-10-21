// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { BRAND } from "@anhourmail/shared";

import { PageHero } from "@/components/sections";
import { WaitlistForm } from "@/components/waitlist-form";

export const metadata: Metadata = {
  title: "Join the waitlist",
  description: `Get an invite to ${BRAND.product}: private, fast email with your own domain and masked aliases.`,
  alternates: { canonical: "/waitlist" },
  openGraph: { title: "Join the waitlist · AnhourMail", url: "/waitlist" },
};

export default function WaitlistPage() {
  return (
    <PageHero
      title="Join the waitlist"
      lead="We invite people in small groups. You’ll get one email to confirm your address, and one when your invite is ready."
      actions={false}
    >
      <div className="mx-auto flex justify-center rounded-[30px] bg-[rgb(var(--am-site-night))] px-6 py-10 ring-1 ring-white/10">
        <WaitlistForm />
      </div>
    </PageHero>
  );
}
