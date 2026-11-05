// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

import { can } from "@anhourmail/core";
import { startImportBatch } from "@anhourmail/core/imports";
import { IMPORT } from "@anhourmail/shared/import";

import { getActorAndSession } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";
import { chargeImportStarts, importContext, sendImportNotice } from "@/server/imports";
import { BodyTooLargeError, readCappedBytes } from "@/server/webmail/http";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * The admins' batch migration (ADR-0030 §8): the raw CSV as the body (`text/csv`, up to `IMPORT.batchMaxBytes`), one
 * row per mailbox. Parsed here and never stored; each valid row becomes its own import with its own credential. Needs
 * `mailbox.import.any` and a fresh step-up (403 `step_up_required`). Answers `{ batchId, rows, started, invalid }`;
 * invalid rows carry their line number and a code, never their values. The valid rows count against the account's
 * daily starts (`importStartAccount`, 429 when too few are left). Each mailbox's person is emailed when an admin
 * started an import into their mailbox.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const { actor, sessionId } = await getActorAndSession(req.headers);
    const accountId = str(params.accountId);
    let bytes: Uint8Array;
    try {
      bytes = await readCappedBytes(req, IMPORT.batchMaxBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return NextResponse.json(
          { error: { code: "too_large", message: `The file can be up to ${String(IMPORT.batchMaxBytes / 1024)} KB.` } },
          { status: 413 },
        );
      }
      throw err;
    }
    const out = await startImportBatch(
      container().deps,
      importContext(),
      actor,
      accountId,
      bytes,
      { sessionId },
      meta,
      // Each valid row is a start against the account's daily budget, charged only for callers who may import there
      // (as for a single start, so nobody outside can use up an account's budget).
      can(actor, "mailbox.import.own", accountId) ? (rows) => chargeImportStarts(accountId, rows) : undefined,
    );
    for (const n of out.notices) await sendImportNotice(accountId, n);
    return ok(out.result, out.result.batchId === null ? 200 : 201);
  },
  { limit: "importBatch" },
);
