// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Customer DKIM against the pinned dev Stalwart: a domain the worker adds with the provisioning key gets an Ed25519 and
 * an RSA key, and `domainDkimKeys` reads both from the zone file as the TXT records the console shows. Throwaway
 * domains, destroyed afterwards.
 */
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

import { stalwartMailServer } from ".";
import { issueTestKeys, type TestKeys } from "./int-keys";

const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
if (!stalwartUrl || !admin || !adminPassword) {
  throw new Error("integration tests need STALWART_URL and the dev Stalwart admin");
}

const devAdmin = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const tag = randomUUID().slice(0, 8);
const keysDomain = `dkimkeys-${tag}.test`;
const customer = `dkim-${tag}.test`;
let keys: TestKeys | null = null;

afterAll(async () => {
  const d = (await devAdmin.listDomains()).find((x) => x.name === customer);
  if (d) await devAdmin.destroyDomain(d.id);
  await keys?.cleanup();
});

describe("DKIM keys from the mail server", () => {
  it("reads a new domain's Ed25519 and RSA keys with the provisioning key", async () => {
    keys = await issueTestKeys(devAdmin, stalwartUrl, keysDomain);
    const mail = stalwartMailServer(keys.provisioning);
    const { externalId } = await mail.ensureDomain(customer);

    // The RSA key is generated a moment after the domain (the job retries until it is there).
    let found = await mail.domainDkimKeys(externalId);
    for (let i = 0; i < 40 && !found.some((k) => k.value.includes("k=rsa")); i++) {
      await new Promise((r) => setTimeout(r, 250));
      found = await mail.domainDkimKeys(externalId);
    }
    expect(found.map((k) => k.selector).sort()).toEqual([
      expect.stringMatching(/^v1-ed25519-\d{8}$/),
      expect.stringMatching(/^v1-rsa-\d{8}$/),
    ]);
    const rsa = found.find((k) => k.value.includes("k=rsa"))?.value ?? "";
    // One joined value: the RSA-2048 public key (SubjectPublicKeyInfo, ~392 base64 characters), no quotes or breaks.
    expect(rsa).toMatch(/^v=DKIM1; k=rsa; h=sha256; p=MIIB[A-Za-z0-9+/]{380,}={0,2}$/);
    expect(found.find((k) => k.value.includes("k=ed25519"))?.value).toMatch(
      /^v=DKIM1; k=ed25519; h=sha256; p=[A-Za-z0-9+/]{43}=$/,
    );
    // The same keys on every read (nothing rotates them while DNS is managed by hand).
    expect(await mail.domainDkimKeys(externalId)).toEqual(found);
    expect(await mail.domainDkimKeys("nope")).toEqual([]);
  });
});
