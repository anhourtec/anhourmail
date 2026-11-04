// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import type { FakeObjectView } from "@anhourmail/adapters/billing";
import { DomainError, UnauthenticatedError } from "@anhourmail/core";

import { getActor } from "@/server/auth/actor";
import { devBilling, devObjectFor } from "@/server/dev-billing";

/**
 * The fake object a dev billing page shows (ADR-0029 §3). 404 unless billing is the fake outside production (layer 2;
 * production builds never route `/dev/` at all, layer 3), for an unknown object, or when the person may not manage
 * billing in its account. Signed out → sign-in.
 */
export async function loadDevObject(kind: "checkout" | "customer", id: string): Promise<FakeObjectView> {
  const provider = devBilling();
  if (!provider) notFound();
  const actor = await getActor(await headers());
  try {
    return await devObjectFor(provider, actor, kind, id);
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect("/sign-in");
    if (err instanceof DomainError) notFound();
    throw err;
  }
}

export const money = (minor: number, currency: string): string => `${(minor / 100).toFixed(2)} ${currency}`;
