// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ON_BEHALF_EXPIRES_HEADER, ON_BEHALF_HEADER, onBehalfTag } from "@anhourmail/core/webmail";
import {
  SENDER_ON_BEHALF_EXPIRES_HEADER,
  SENDER_ON_BEHALF_HEADER,
  senderIdentitySieve,
} from "@anhourmail/stalwart-client";

/**
 * The web app's on-behalf tag (core) and the mail server's check (the sender-identity Sieve script) are written twice,
 * once in TypeScript and once as a Stalwart expression; this pins them to each other (ADR-0026 §8). `npm run
 * stack:verify` proves the same against the running server.
 */
describe("send-on-behalf tag: web app and mail server agree", () => {
  const key = "a1b2c3d4".repeat(8);

  it("use the same header", () => {
    expect(ON_BEHALF_HEADER).toBe(SENDER_ON_BEHALF_HEADER);
    expect(ON_BEHALF_EXPIRES_HEADER).toBe(SENDER_ON_BEHALF_EXPIRES_HEADER);
    expect(senderIdentitySieve({ onBehalfKey: key })).toContain(`header :is "${ON_BEHALF_HEADER}"`);
  });

  it("hash the same input: K | sha256(K | lowercase envelope | lowercase Sender | Message-ID | expiry)", () => {
    const script = senderIdentitySieve({ onBehalfKey: key });
    expect(script).toContain(
      `let "onbehalf" "hash('${key}|' + hash('${key}|' + to_lowercase(envelope.from) + '|' + to_lowercase(header.sender.addr) + '|' + header.message-id + '|' + header.x-anhourmail-on-behalf-expires, 'sha256'), 'sha256')";`,
    );
    // What the script computes for envelope "Box@Example.org", Sender "Me@Example.org", Message-ID <Ab.1@h> (the server
    // reads the id without its angle brackets, case kept — verified on v0.16.27) and expiry 2026-10-30T09:31:37Z:
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const exp = "2026-10-30T09:31:37Z";
    const server = sha(`${key}|${sha(`${key}|box@example.org|me@example.org|Ab.1@h|${exp}`)}`);
    expect(onBehalfTag(key, "Box@Example.org", "Me@Example.org", "<Ab.1@h>", exp)).toBe(server);
  });

  it("check the expiry in the form the tag is made in", () => {
    const script = senderIdentitySieve({ onBehalfKey: key });
    expect(script).toContain('"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"');
    expect(script).toContain('if not currentdate :zone "+0000" :value "le" "iso8601" "${onbehalfexp}"');
    expect(script).toContain('"^[A-Za-z0-9._%+=-]{1,200}@[A-Za-z0-9.-]{1,200}$"');
  });
});
