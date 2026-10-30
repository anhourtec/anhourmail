// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { StalwartTransport } from "./client";
import { StalwartManagement } from "./management";
import {
  allRecipientsLocalExpression,
  applySenderIdentityPolicy,
  INBOUND_HEADERS_SCRIPT,
  INBOUND_HEADERS_SIEVE,
  INTERNAL_MAIL_HEADER,
  SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION,
  SENDER_IDENTITY_SCRIPT,
  SENDER_IDENTITY_SIEVE,
  SENDER_ON_BEHALF_EXPIRES_HEADER,
  SENDER_ON_BEHALF_HEADER,
  senderIdentitySieve,
} from "./sender";

// A dummy 64-hex key, built in code so secret scanners don't take it for a real one.
const KEY = Array.from({ length: 64 }, (_, i) => (i % 16).toString(16)).join("");

type Call = [string, Record<string, unknown>, string];

function fake(scripts: { id: string; name: string; contents?: string; isActive?: boolean }[]) {
  const sets: Call[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { methodCalls: Call[] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "x:SieveSystemScript/get") return [name, { list: scripts }, id];
      sets.push([name, args, id]);
      if (name === "x:SieveSystemScript/set" && args.create) return [name, { created: { s: { id: "new1" } } }, id];
      return [name, { updated: {} }, id];
    });
    return Response.json({ methodResponses });
  }) as typeof fetch;
  const mgmt = new StalwartManagement(
    new StalwartTransport({ baseUrl: "http://s", auth: { type: "bearer", token: "k" }, fetch: fetchImpl }),
  );
  return { mgmt, sets };
}

describe("sender identity policy", () => {
  it("creates both scripts before wiring them to DATA, and keeps mustMatchSender on", async () => {
    const { mgmt, sets } = fake([]);
    expect(await applySenderIdentityPolicy(mgmt)).toEqual({ scriptId: "new1", inboundScriptId: "new1" });
    const created = sets
      .filter(([n]) => n === "x:SieveSystemScript/set")
      .map(([, a]) => (a.create as Record<string, { name: string; contents: string }>).s);
    expect(created.map((c) => c?.name)).toEqual([SENDER_IDENTITY_SCRIPT, INBOUND_HEADERS_SCRIPT]);
    expect(created[1]?.contents).toBe(INBOUND_HEADERS_SIEVE);
    const data = sets.find(([n]) => n === "x:MtaStageData/set")?.[1].update as Record<string, { script: unknown }>;
    expect(data.singleton?.script).toEqual(SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION);
    expect(sets.findIndex(([n]) => n === "x:MtaStageData/set")).toBe(2);
    expect(sets.some(([n]) => n === "x:MtaStageAuth/set")).toBe(true);
  });

  it("runs the sender-identity script for authenticated sessions and the inbound one for all others", () => {
    expect(SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION).toEqual({
      match: { "0": { if: "!is_empty(authenticated_as)", then: `'${SENDER_IDENTITY_SCRIPT}'` } },
      else: `'${INBOUND_HEADERS_SCRIPT}'`,
    });
  });

  it("inbound script removes the internal-mail marker and nothing else", () => {
    expect(INBOUND_HEADERS_SIEVE).toMatch(/^require \["editheader"\];/);
    const actions = INBOUND_HEADERS_SIEVE.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(actions).toEqual(['require ["editheader"];', `deleteheader "${INTERNAL_MAIL_HEADER}";`]);
  });

  it("is idempotent when the scripts are already current, and repairs drifted ones", async () => {
    const current = fake([
      { id: "s1", name: SENDER_IDENTITY_SCRIPT, contents: SENDER_IDENTITY_SIEVE, isActive: true },
      { id: "s2", name: INBOUND_HEADERS_SCRIPT, contents: INBOUND_HEADERS_SIEVE.trimEnd(), isActive: true },
    ]);
    await applySenderIdentityPolicy(current.mgmt);
    expect(current.sets.some(([n]) => n === "x:SieveSystemScript/set")).toBe(false);
    const drifted = fake([
      { id: "s1", name: SENDER_IDENTITY_SCRIPT, contents: "old", isActive: false },
      { id: "s2", name: INBOUND_HEADERS_SCRIPT, contents: INBOUND_HEADERS_SIEVE, isActive: false },
    ]);
    await applySenderIdentityPolicy(drifted.mgmt);
    const upd = drifted.sets
      .filter(([n]) => n === "x:SieveSystemScript/set")
      .map(([, a]) => a.update as Record<string, unknown>);
    expect(upd).toEqual([
      { s1: { contents: SENDER_IDENTITY_SIEVE, isActive: true } },
      { s2: { contents: INBOUND_HEADERS_SIEVE, isActive: true } },
    ]);
  });

  it("without a key, removes any internal-mail marker and adds none", () => {
    expect(SENDER_IDENTITY_SIEVE).toContain(`deleteheader "${INTERNAL_MAIL_HEADER}";`);
    expect(SENDER_IDENTITY_SIEVE).not.toContain("addheader");
  });

  it("with a key, adds the marker last, bound to the envelope sender and one Message-ID in the web app's form", () => {
    const script = senderIdentitySieve({ onBehalfKey: KEY });
    // The formula `internalMailTag` (@anhourmail/core/webmail) recomputes; its unit test states the same.
    const tag = `hash('${KEY}|' + hash('${KEY}|internal-mail-v1|' + to_lowercase(envelope.from) + '|' + header.message-id, 'sha256'), 'sha256')`;
    expect(script).toContain(`let "internaltag" "${tag}";`);
    const order = [
      '"from" "${envelope.from}"',
      'deleteheader "Authentication-Results";',
      `deleteheader "${INTERNAL_MAIL_HEADER}";`,
      `let "internallocal" "${allRecipientsLocalExpression()}";`,
      'if allof (string :is "${internallocal}" "1", header :count "eq" :comparator "i;ascii-numeric" "message-id" "1")',
      'if string :regex "${internalid}" "^[A-Za-z0-9._%+=-]{1,200}@[A-Za-z0-9.-]{1,200}$"',
      'let "internaltag"',
      'if string :regex "${internaltag}" "^[0-9a-f]{64}$"',
      `addheader "${INTERNAL_MAIL_HEADER}" "\${internaltag}";`,
    ].map((needle) => script.indexOf(needle));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(script.match(/addheader/g)).toHaveLength(1);
  });

  it("marks only mail whose recipients are all local, checking each by index up to the limit", () => {
    const expr = allRecipientsLocalExpression(3);
    expect(expr).toBe(
      [
        "count(envelope.to) >= 1",
        "count(envelope.to) <= 3",
        ...[0, 1, 2].map(
          (i) =>
            `(is_empty(envelope.to[${String(i)}]) || is_local_domain(email_part(envelope.to[${String(i)}], 'domain')))`,
        ),
      ].join(" && "),
    );
    // The default covers Stalwart's default recipient limit; more recipients means no marker.
    expect(allRecipientsLocalExpression().match(/is_local_domain/g)).toHaveLength(100);
    expect(allRecipientsLocalExpression()).toContain("count(envelope.to) <= 100");
  });

  it("script compares header From and Sender to the envelope sender and needs exactly one From", () => {
    expect(SENDER_IDENTITY_SIEVE).toContain('"from" "${envelope.from}"');
    expect(SENDER_IDENTITY_SIEVE).toContain('"sender" "${envelope.from}"');
    expect(SENDER_IDENTITY_SIEVE).toContain(':count "ne"');
  });

  it("script strips every Authentication-Results header from submitted mail", () => {
    expect(SENDER_IDENTITY_SIEVE).toMatch(/^require \[[^\]]*"editheader"/);
    expect(SENDER_IDENTITY_SIEVE).toContain('deleteheader "Authentication-Results";');
  });

  it("script needs exactly one Sender address when a Sender header is present", () => {
    for (const script of [SENDER_IDENTITY_SIEVE, senderIdentitySieve({ onBehalfKey: KEY })]) {
      expect(script).toContain(':count "ne" :comparator "i;ascii-numeric" :all "sender" "1"');
      expect(script.indexOf('"sender" "1"')).toBeLessThan(script.indexOf('"sender" "${envelope.from}"'));
    }
  });

  it("without a key, a Sender other than the envelope sender is always refused", () => {
    expect(SENDER_IDENTITY_SIEVE).toBe(senderIdentitySieve());
    expect(SENDER_IDENTITY_SIEVE).not.toContain("vnd.stalwart.expressions");
    expect(SENDER_IDENTITY_SIEVE).not.toContain("hash(");
    expect(SENDER_IDENTITY_SIEVE).toContain(`deleteheader "${SENDER_ON_BEHALF_HEADER}";`);
    expect(SENDER_IDENTITY_SIEVE).toContain(`deleteheader "${SENDER_ON_BEHALF_EXPIRES_HEADER}";`);
  });

  it("with a key, compiles the message-bound on-behalf check", () => {
    const script = senderIdentitySieve({ onBehalfKey: KEY });
    expect(script).toMatch(/^require \[[^\]]*"regex", "date", "vnd\.stalwart\.expressions"\]/);
    const inner = `hash('${KEY}|' + to_lowercase(envelope.from) + '|' + to_lowercase(header.sender.addr) + '|' + header.message-id + '|' + header.x-anhourmail-on-behalf-expires, 'sha256')`;
    expect(script).toContain(`let "onbehalf" "hash('${KEY}|' + ${inner}, 'sha256')";`);
    // Exactly one Message-ID and expiry, both in the web app's form, not expired, a real digest, then the comparison.
    const order = [
      ':count "ne" :comparator "i;ascii-numeric" "message-id" "1"',
      `:count "ne" :comparator "i;ascii-numeric" "${SENDER_ON_BEHALF_EXPIRES_HEADER}" "1"`,
      'if not string :regex "${onbehalfid}"',
      'if not string :regex "${onbehalfexp}"',
      'if not currentdate :zone "+0000" :value "le" "iso8601" "${onbehalfexp}"',
      'let "onbehalf"',
      'if not string :regex "${onbehalf}" "^[0-9a-f]{64}$"',
      `if not header :is "${SENDER_ON_BEHALF_HEADER}" "\${onbehalf}"`,
    ].map((needle) => script.indexOf(needle));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // From is still checked first and unconditionally, and the tag never leaves the server.
    expect(script.indexOf('"from" "${envelope.from}"')).toBeLessThan(script.indexOf("hash("));
    expect(script).toContain(`deleteheader "${SENDER_ON_BEHALF_HEADER}";`);
    expect(script).toContain(`deleteheader "${SENDER_ON_BEHALF_EXPIRES_HEADER}";`);
    expect(script).toContain('deleteheader "Authentication-Results";');
  });

  it("never passes Stalwart's error details on (they can quote the script, which holds the key)", async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { methodCalls: Call[] };
      const methodResponses = body.methodCalls.map(([name, , id]) =>
        name === "x:SieveSystemScript/get"
          ? [name, { list: [] }, id]
          : [
              name,
              { notCreated: { s: { type: "invalidProperties", description: `bad expression hash('${KEY}|'` } } },
              id,
            ],
      );
      return Response.json({ methodResponses });
    }) as typeof fetch;
    const mgmt = new StalwartManagement(
      new StalwartTransport({ baseUrl: "http://s", auth: { type: "bearer", token: "k" }, fetch: fetchImpl }),
    );
    const err = await applySenderIdentityPolicy(mgmt, { onBehalfKey: KEY }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const text = JSON.stringify({ message: (err as Error).message, cause: (err as Error).cause ?? null });
    expect(text).toContain("Could not apply the sender-identity policy");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("bad expression");
  });

  it("names a malformed key as such when applying (no Stalwart call)", async () => {
    const { mgmt, sets } = fake([]);
    await expect(applySenderIdentityPolicy(mgmt, { onBehalfKey: "short" })).rejects.toThrow(/64 lowercase hex/);
    expect(sets).toEqual([]);
  });

  it("refuses a key that could break out of the script text", () => {
    for (const bad of ["", "short", KEY.toUpperCase(), `${KEY.slice(0, 63)}'`, `${KEY.slice(0, 63)}"`, `${KEY}00`]) {
      expect(() => senderIdentitySieve({ onBehalfKey: bad })).toThrow(/64 lowercase hex/);
    }
  });

  it("installs the keyed script and updates a strict one to it", async () => {
    const keyed = senderIdentitySieve({ onBehalfKey: KEY });
    const strict = fake([{ id: "s1", name: SENDER_IDENTITY_SCRIPT, contents: SENDER_IDENTITY_SIEVE, isActive: true }]);
    await applySenderIdentityPolicy(strict.mgmt, { onBehalfKey: KEY });
    const upd = strict.sets.find(([n]) => n === "x:SieveSystemScript/set")?.[1].update as Record<string, unknown>;
    expect(upd.s1).toEqual({ contents: keyed, isActive: true });
    // As stored by Stalwart: without the final newline.
    const current = fake([
      { id: "s1", name: SENDER_IDENTITY_SCRIPT, contents: keyed.trimEnd(), isActive: true },
      { id: "s2", name: INBOUND_HEADERS_SCRIPT, contents: INBOUND_HEADERS_SIEVE.trimEnd(), isActive: true },
    ]);
    await applySenderIdentityPolicy(current.mgmt, { onBehalfKey: KEY });
    expect(current.sets.some(([n]) => n === "x:SieveSystemScript/set")).toBe(false);
  });
});
