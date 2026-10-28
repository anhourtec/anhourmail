// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { StalwartTransport } from "./client";
import { dkimTags, parseDkimRecords } from "./dkim";
import { StalwartManagement } from "./management";

const ED25519 = "v=DKIM1; k=ed25519; h=sha256; p=T5HnScT90Bl3e6wOsAR2tTVmRw1MPWtI1rTOoxMB4dY=";
const RSA_1 =
  "v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxXpp4B/gtwAbvcCCkpj34jR0J4OJnobgRdxyFruYL0MUK8aFxsbsCPRrE8nVhkkK7a6LyI3cf5+eVdoE/ITTGtBlIwdgDAwdFEq5Byd6bLfOXADz1M4OBSn7OvZuEI943nhiD+QfdjsYzqBpX/CRGxDFXl2M4r7nhpO0ofZmObiJ4sRSFNYvqR6";
const RSA_2 =
  "g5EImsugnVEyNx2yaiohi2PHv83H9F1ZeDC4Y13owTUIqEzruepFdbKf+JQW55OHp/8TABqDfRiQeB0dVRRiz/jBzQQEK0wZKUQwIksj6iCHzdNYyTHzTpWK9zf7dTEejlE9GM0zIoac96a9QeKyUECJTDKjYLQIDAQAB";

/** A zone as the pinned v0.16.27 writes it (captured from `x:Domain/get` → `dnsZoneFile`, domain renamed). */
const ZONE = [
  `v1-ed25519-20261028._domainkey.example.org. IN TXT "${ED25519}"`,
  "v1-rsa-20261028._domainkey.example.org. IN TXT (",
  `    "${RSA_1}"`,
  `    "${RSA_2}"`,
  ")",
  'example.org. IN TXT "v=spf1 mx -all"',
  "example.org. IN MX 10 mail.dev.test.",
  '_dmarc.example.org. IN TXT "v=DMARC1; p=reject; rua=mailto:postmaster@example.org"',
  "_submissions._tcp.example.org. IN SRV 0 1 465 mail.dev.test.",
  'example.org. IN CAA 0 issue "letsencrypt.org"',
  'v1-rsa-20261028._domainkey.example.org. IN TXT "v=spf1 -all"',
  "autoconfig.example.org. IN CNAME mail.dev.test.",
  "",
].join("\n");

describe("parseDkimRecords", () => {
  it("reads the Ed25519 and the split RSA key from a real zone file", () => {
    const keys = parseDkimRecords(ZONE, "example.org");
    expect(keys).toEqual([
      { selector: "v1-ed25519-20261028", value: ED25519 },
      { selector: "v1-rsa-20261028", value: RSA_1 + RSA_2 },
    ]);
    const rsa = dkimTags(keys[1]!.value);
    expect(rsa.get("k")).toBe("rsa");
    expect(rsa.get("p")).toMatch(/^MIIBIjAN.*IDAQAB$/);
  });

  it("handles TTLs, classes, escaped quotes, comments and names without the final dot", () => {
    const zone = [
      "; generated",
      'sel1._domainkey.Example.ORG 3600 IN TXT "v=DKIM1; k=rsa; " "p=AB\\"CD" ; trailing comment',
      'sel2._domainkey.example.org. TXT ( "v=DKIM1;"',
      '  "k=ed25519; p=XYZ=" )',
    ].join("\n");
    expect(parseDkimRecords(zone, "example.org.")).toEqual([
      { selector: "sel1", value: 'v=DKIM1; k=rsa; p=AB"CD' },
      { selector: "sel2", value: "v=DKIM1;k=ed25519; p=XYZ=" },
    ]);
  });

  it("ignores revoked keys, other domains, nested names and other record types", () => {
    const zone = [
      'gone._domainkey.example.org. IN TXT "v=DKIM1; k=rsa; p="',
      'a._domainkey.other.org. IN TXT "v=DKIM1; p=AAA"',
      'a.b._domainkey.example.org. IN TXT "v=DKIM1; p=AAA"',
      "c._domainkey.example.org. IN CNAME c.example.net.",
      'd._domainkey.example.org. IN TXT "v=DKIM2; p=AAA"',
    ].join("\n");
    expect(parseDkimRecords(zone, "example.org")).toEqual([]);
    expect(parseDkimRecords("", "example.org")).toEqual([]);
  });
});

describe("StalwartManagement.domainDkimRecords", () => {
  it("reads the domain's name and zone and returns its keys", async () => {
    const asked: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
      const [[name, args, id]] = body.methodCalls as [[string, Record<string, unknown>, string]];
      asked.push([name, args]);
      return Response.json({
        methodResponses: [[name, { list: [{ id: "d1", name: "example.org", dnsZoneFile: ZONE }] }, id]],
      });
    }) as typeof fetch;
    const m = new StalwartManagement(
      new StalwartTransport({
        baseUrl: "http://stalwart:8080/",
        auth: { type: "bearer", token: "t" },
        fetch: fetchImpl,
      }),
    );
    expect((await m.domainDkimRecords("d1")).map((k) => k.selector)).toEqual([
      "v1-ed25519-20261028",
      "v1-rsa-20261028",
    ]);
    expect(asked[0]).toMatchObject(["x:Domain/get", { ids: ["d1"], properties: ["name", "dnsZoneFile"] }]);
  });

  it("returns nothing for a domain that is gone", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { methodCalls: [string, unknown, string][] };
      const [[name, , id]] = body.methodCalls as [[string, unknown, string]];
      return Response.json({ methodResponses: [[name, { list: [], notFound: ["d9"] }, id]] });
    }) as typeof fetch;
    const m = new StalwartManagement(
      new StalwartTransport({
        baseUrl: "http://stalwart:8080/",
        auth: { type: "bearer", token: "t" },
        fetch: fetchImpl,
      }),
    );
    expect(await m.domainDkimRecords("d9")).toEqual([]);
  });
});
