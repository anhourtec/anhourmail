// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { PageHero } from "@/components/sections";

import { ConfirmWaitlist } from "./confirm-waitlist";

export const metadata: Metadata = {
  title: "Confirm your address",
  robots: { index: false, follow: false },
  alternates: { canonical: "/waitlist/confirm" },
};

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : null;
  return <PageHero title="Confirm your address" lead={<ConfirmWaitlist token={token} />} actions={false} />;
}
