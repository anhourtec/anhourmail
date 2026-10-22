// SPDX-License-Identifier: AGPL-3.0-only
import { route } from "@/server/http/route";
import { handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";
import { isJmapId } from "@/server/webmail/view";

/** Downloads contacts (all, or `?ids=a,b`) as a vCard file built and escaped by the BFF. */
export const GET = route(
  async ({ req }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const raw = new URL(req.url).searchParams.get("ids");
    const ids = raw ? raw.split(",").filter(isJmapId).slice(0, 5000) : undefined;
    return handleWebmail(async () => {
      const vcf = await webmail().exportContacts(id, ids);
      return new Response(vcf, {
        status: 200,
        headers: {
          "Content-Type": "text/vcard; charset=utf-8",
          "Content-Disposition": 'attachment; filename="contacts.vcf"',
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    });
  },
  { session: "webmail", limit: "webmailDownload" },
);
