// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { readiness } from "@/server/health";

export const dynamic = "force-dynamic";

/** Readiness: 200 when Postgres, Redis and Stalwart answer, 503 otherwise. Statuses and latencies only. */
export async function GET() {
  const r = await readiness();
  return NextResponse.json(r, { status: r.status === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
