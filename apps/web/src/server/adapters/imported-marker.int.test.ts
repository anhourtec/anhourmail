// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SA-64-01 (ADR-0030 run-64 update) against the real dev Stalwart: a message appended over IMAP with the import
 * credential, as the importer writes it — our marker on top, and below it a forged `Received … by <our MX>` with an
 * `Authentication-Results: <our authserv-id>` passing DMARC for a bank, plus a valid-looking internal-mail marker —
 * is never "verified by us" in the webmail: no results, no internal marker, no image loading. The same headers without
 * our marker line would have counted (the control), so the test proves the marker is what stops it. An APPEND adds no
 * header of the server's own above ours (pinned too).
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { hashPassword } from "@anhourmail/adapters/auth";
import { internalMailTag } from "@anhourmail/core/webmail";
import { IMPORT_MARKER_HEADER } from "@anhourmail/shared/import";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

import { imapSession } from "../../../../../packages/adapters/src/stalwart/int-imap";
import { issueTestKeys } from "../../../../../packages/adapters/src/stalwart/int-keys";
import { senderVerified } from "../webmail/image-proxy";
import { authResults, isImportedMail, isInternalMail, parseHeaderBlock } from "../webmail/original";

const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
if (!stalwartUrl || !admin || !adminPassword) throw new Error("integration tests need the dev Stalwart admin");

const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const tag = randomUUID().slice(0, 8);
const keys = await issueTestKeys(mgmt, stalwartUrl, `svc-${tag}.test`);
const domain = `mrk-${tag}.test`;
const address = `dest@${domain}`;
const OURS = ["mail.dev.test"];
const KEY = Array.from({ length: 64 }, (_, i) => (i % 16).toString(16)).join("");
const FROM = "alerts@bank.example";
const MID = `${tag}@bank.example`;

afterAll(async () => {
  try {
    // The samples this test's APPENDs created on the throwaway account (the shared spam model; ADR-0030).
    const samples = await mgmt.transport.getAll<{ id: string; accountId?: string }>("x:SpamTrainingSample", [
      "accountId",
    ]);
    const ours = samples.filter((s) => s.accountId === accountId).map((s) => s.id);
    if (ours.length > 0) await mgmt.transport.set("x:SpamTrainingSample", { destroy: ours }).catch(() => undefined);
    for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
      await mgmt.destroy("x:Account", u.id);
    }
    // An account's removal can take a moment to let go of its domain.
    for (let i = 0; i < 5; i++) {
      const d = (await mgmt.listDomains()).find((x) => x.name === domain);
      if (!d) break;
      const gone = await mgmt.destroyDomain(d.id).then(
        () => true,
        () => false,
      );
      if (gone) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await keys.cleanup();
  }
});

/** A copy of "mail our server once received", as a hostile source mailbox could hold it. */
const forged = (withMarker: boolean) =>
  [
    ...(withMarker ? [`${IMPORT_MARKER_HEADER}: ${randomUUID()}`] : []),
    "Received: from mx.bank.example (mx.bank.example [192.0.2.10]) by mail.dev.test (Stalwart SMTP) with ESMTPS id 1;",
    "\tTue, 3 Feb 2015 10:00:00 +0000",
    "Authentication-Results: mail.dev.test; spf=pass smtp.mailfrom=bank.example; dkim=pass header.d=bank.example;",
    "\tdmarc=pass header.from=bank.example",
    `X-AnhourMail-Internal: ${internalMailTag(KEY, FROM, `<${MID}>`) ?? ""}`,
    `From: Bank <${FROM}>`,
    `To: ${address}`,
    `Subject: forged ${tag}`,
    `Message-ID: <${MID}>`,
    "Date: Tue, 3 Feb 2015 10:00:00 +0000",
    "",
    'Look: <img src="https://tracker.example/p.gif">',
    "",
  ].join("\r\n");

let accountId = "";

describe("imported mail is never verified by us (SA-64-01, on the dev Stalwart)", () => {
  it("appends a forged pair below our marker and reads it back as unverified", async () => {
    await keys.provisioning.upsertDomain({ name: domain });
    accountId = await keys.provisioning.upsertUser({
      name: "dest",
      domain,
      password: await hashPassword(randomBytes(18).toString("base64url")),
      quotaBytes: 50 * 1024 * 1024,
      suspended: false,
    });
    const credential = await keys.operations.createImportCredential(accountId, new Date(Date.now() + 600_000));
    const s = await imapSession();
    try {
      expect(await s.run(`LOGIN "${address}" "${credential.secret}"`)).toMatch(/^t1 OK/m);
      const raw = forged(true);
      expect(await s.run(`APPEND "INBOX" () {${String(Buffer.byteLength(raw))}+}\r\n${raw}`)).toMatch(/OK/);
      expect(await s.run("EXAMINE INBOX")).toMatch(/\* 1 EXISTS/);
      const fetched = await s.run("UID FETCH 1:* (BODY.PEEK[HEADER])");
      const block = fetched.slice(fetched.indexOf("\r\n") + 2);
      const headers = parseHeaderBlock(block);
      // Our marker is the topmost header: the APPEND added nothing of the server's own above it.
      expect(headers[0]?.name).toBe(IMPORT_MARKER_HEADER);
      expect(isImportedMail(headers)).toBe(true);
      expect(authResults(headers, OURS)).toBeNull();
      expect(isInternalMail(headers, FROM, KEY, OURS)).toBe(false);
      expect(senderVerified(FROM, authResults(headers, OURS), isInternalMail(headers, FROM, KEY, OURS))).toBe(false);
    } finally {
      s.close();
    }
  });

  it("the same headers without our marker would have counted (the control)", () => {
    const headers = parseHeaderBlock(forged(false));
    const auth = authResults(headers, OURS);
    expect(auth?.dmarc).toMatchObject({ result: "pass", domain: "bank.example" });
    expect(senderVerified(FROM, auth)).toBe(true);
  });
});
