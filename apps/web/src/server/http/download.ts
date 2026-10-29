// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

/**
 * A ZIP the browser saves rather than shows (data exports, ADR-0025): `attachment` with an ASCII file name we chose,
 * no sniffing, never cached. `route()` adds the API CSP and `no-store`.
 */
export function archiveResponse(bytes: Uint8Array, filename: string): Response {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safe}"`,
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * True when the browser says another site started this request (`Sec-Fetch-Site: cross-site` or `same-site`). Export
 * downloads are GETs with a side effect (an audited download, a rate-limit slot), so a link or form elsewhere must not
 * trigger them; our own pages send `same-origin`, a typed URL or bookmark `none`, and old browsers nothing.
 */
export function fromAnotherSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

/** The 403 for `fromAnotherSite`, in the API envelope. */
export function crossSiteRefused(): Response {
  return Response.json(
    { error: { code: "forbidden", message: "Start the download from AnhourMail itself." } },
    { status: 403 },
  );
}
