// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { StalwartTransport } from "./client";
import { StalwartManagement } from "./management";
import {
  applySenderIdentityPolicy,
  SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION,
  SENDER_IDENTITY_SCRIPT,
  SENDER_IDENTITY_SIEVE,
  SENDER_ON_BEHALF_EXPIRES_HEADER,
  SENDER_ON_BEHALF_HEADER,
  senderIdentitySieve,
} from "./sender";

const KEY = "0123456789abcdef".repeat(4);

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
  it("creates the script, wires it to authenticated DATA and keeps mustMatchSender on", async () => {
    const { mgmt, sets } = fake([]);
    expect(await applySenderIdentityPolicy(mgmt)).toEqual({ scriptId: "new1" });
    const created = sets.find(([n]) => n === "x:SieveSystemScript/set")?.[1].create as Record<string, { name: string }>;
    expect(created.s?.name).toBe(SENDER_IDENTITY_SCRIPT);
    const data = sets.find(([n]) => n === "x:MtaStageData/set")?.[1].update as Record<string, { script: unknown }>;
    expect(data.singleton?.script).toEqual(SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION);
    expect(sets.some(([n]) => n === "x:MtaStageAuth/set")).toBe(true);
  });

  it("is idempotent when the script is already current, and repairs a drifted one", async () => {
    const current = fake([{ id: "s1", name: SENDER_IDENTITY_SCRIPT, contents: SENDER_IDENTITY_SIEVE, isActive: true }]);
    await applySenderIdentityPolicy(current.mgmt);
    expect(current.sets.some(([n]) => n === "x:SieveSystemScript/set")).toBe(false);
    const drifted = fake([{ id: "s1", name: SENDER_IDENTITY_SCRIPT, contents: "old", isActive: false }]);
    await applySenderIdentityPolicy(drifted.mgmt);
    const upd = drifted.sets.find(([n]) => n === "x:SieveSystemScript/set")?.[1].update as Record<string, unknown>;
    expect(upd.s1).toEqual({ contents: SENDER_IDENTITY_SIEVE, isActive: true });
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
    const current = fake([{ id: "s1", name: SENDER_IDENTITY_SCRIPT, contents: keyed.trimEnd(), isActive: true }]);
    await applySenderIdentityPolicy(current.mgmt, { onBehalfKey: KEY });
    expect(current.sets.some(([n]) => n === "x:SieveSystemScript/set")).toBe(false);
  });
});
