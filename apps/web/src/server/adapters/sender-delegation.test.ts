// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ON_BEHALF_HEADER, onBehalfTag } from "@anhourmail/core/webmail";
import { SENDER_ON_BEHALF_HEADER, senderIdentitySieve } from "@anhourmail/stalwart-client";

/**
 * The web app's on-behalf tag (core) and the mail server's check (the sender-identity Sieve script) are written twice,
 * once in TypeScript and once as a Stalwart expression; this pins them to each other (ADR-0026 §8). `npm run
 * stack:verify` proves the same against the running server.
 */
describe("send-on-behalf tag: web app and mail server agree", () => {
  const key = "a1b2c3d4".repeat(8);

  it("use the same header", () => {
    expect(ON_BEHALF_HEADER).toBe(SENDER_ON_BEHALF_HEADER);
    expect(senderIdentitySieve({ onBehalfKey: key })).toContain(`header :is "${ON_BEHALF_HEADER}"`);
  });

  it("hash the same input: K | sha256(K | lowercase envelope | lowercase Sender | Message-ID)", () => {
    const script = senderIdentitySieve({ onBehalfKey: key });
    expect(script).toContain(
      `let "onbehalf" "hash('${key}|' + hash('${key}|' + to_lowercase(envelope.from) + '|' + to_lowercase(header.sender.addr) + '|' + header.message-id, 'sha256'), 'sha256')";`,
    );
    // What the script computes for envelope "Box@Example.org", Sender "Me@Example.org" and Message-ID <Ab.1@h> (the
    // server reads the id without its angle brackets, case kept — verified on v0.16.27):
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const server = sha(`${key}|${sha(`${key}|box@example.org|me@example.org|Ab.1@h`)}`);
    expect(onBehalfTag(key, "Box@Example.org", "Me@Example.org", "<Ab.1@h>")).toBe(server);
  });
});
