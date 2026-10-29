// SPDX-License-Identifier: AGPL-3.0-only
import { route } from "@/server/http/route";
import { env } from "@/server/env";
import { BodyTooLargeError, handleWebmail, readCappedText, unauthorized } from "@/server/webmail/http";
import { MAX_IMAGE_REQUEST, serveImage } from "@/server/webmail/image-proxy";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { fetchRemoteImage } from "@/server/webmail/remote-image";

/**
 * The image proxy (docs/internal/05-webmail.md "Remote images"): `{ "token": "<image link>" }` → the image, fetched
 * by us under the SSRF guards in `remote-image.ts`, so the sender never sees the reader's address, cookies or
 * referrer. The link must have been made for this session and its active mailbox (`image-proxy.ts`). The link
 * travels in the body, never the path, so no image address reaches an access log.
 */
export const POST = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    return handleWebmail(async () => {
      let token: unknown;
      try {
        token = (JSON.parse(await readCappedText(req, MAX_IMAGE_REQUEST)) as { token?: unknown } | null)?.token;
      } catch (err) {
        // A body that isn't a small JSON object carries no link this session made: answered like a foreign one.
        if (!(err instanceof BodyTooLargeError || err instanceof SyntaxError)) throw err;
        token = undefined;
      }
      return serveImage(token, {
        secret: env().BETTER_AUTH_SECRET,
        binding: async () => {
          const s = await webmail().session(id);
          return s ? { sessionId: id, accountId: s.accountId } : null;
        },
        fetch: (url) => fetchRemoteImage(url),
      });
    });
  },
  { session: "webmail", limit: "webmailImage" },
);
