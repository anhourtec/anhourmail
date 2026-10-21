// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { liveness } from "@/server/health";

export const dynamic = "force-dynamic";

/** Liveness: the process answers. No database, Redis or network — the container healthcheck calls it. */
export function GET() {
  return NextResponse.json(liveness(), { headers: { "Cache-Control": "no-store" } });
}
