// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { NextResponse } from "next/server";

import { WEBMAIL_SIGNATURES } from "@anhourmail/shared/signatures";

import { BodyTooLargeError, badRequest, readCappedText } from "./http";
import { MAX_SIGNATURE_BODY, SignatureInput } from "./settings";

/**
 * A signature request body (name and HTML), read with a cap before parsing: signatures carry embedded images, so
 * they are larger than other settings, but never more than `MAX_SIGNATURE_BODY`. Returns the input or the response.
 */
export async function readSignatureBody(
  req: Request,
): Promise<{ ok: true; input: ReturnType<typeof SignatureInput.parse> } | { ok: false; res: Response }> {
  let raw: string;
  try {
    raw = await readCappedText(req, MAX_SIGNATURE_BODY);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return {
        ok: false,
        res: NextResponse.json(
          {
            error: {
              code: "too_large",
              message: `A signature can be up to ${String(WEBMAIL_SIGNATURES.signatureKb)} KB, images included.`,
            },
          },
          { status: 413 },
        ),
      };
    }
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, res: badRequest("Request body must be JSON.") };
  }
  const parsed = SignatureInput.safeParse(json);
  if (!parsed.success) return { ok: false, res: badRequest("That signature can't be saved.") };
  return { ok: true, input: parsed.data };
}
