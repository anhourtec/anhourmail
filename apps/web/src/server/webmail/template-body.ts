// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { NextResponse } from "next/server";

import { WEBMAIL_TEMPLATES } from "@anhourmail/shared/templates";

import { BodyTooLargeError, badRequest, readCappedText } from "./http";
import { webmail } from "./instance";
import { MAX_TEMPLATE_BODY, TemplateInput } from "./settings";

/**
 * A template request body (name and HTML), read with a cap before parsing and only for a signed-in webmail session
 * (a random cookie can't make the server buffer it). Returns the input or the response.
 */
export async function readTemplateBody(
  req: Request,
  sessionId: string,
): Promise<{ ok: true; input: ReturnType<typeof TemplateInput.parse> } | { ok: false; res: Response }> {
  if (!(await webmail().session(sessionId))) {
    return {
      ok: false,
      res: NextResponse.json({ error: { code: "unauthorized", message: "Sign in again." } }, { status: 401 }),
    };
  }
  let raw: string;
  try {
    raw = await readCappedText(req, MAX_TEMPLATE_BODY);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return {
        ok: false,
        res: NextResponse.json(
          {
            error: {
              code: "too_large",
              message: `A template can be up to ${String(WEBMAIL_TEMPLATES.templateKb)} KB.`,
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
  const parsed = TemplateInput.safeParse(json);
  if (!parsed.success) return { ok: false, res: badRequest("That template can't be saved.") };
  return { ok: true, input: parsed.data };
}
