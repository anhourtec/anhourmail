// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { StalwartError, type StalwartTransport } from "./client";
import { linkedDkimKeys, StalwartManagement } from "./management";

const linked = (id: string, objects: { object: string; id: string }[]) =>
  new StalwartError("x:Domain/set notDestroyed", "set", {
    [id]: { type: "objectIsLinked", objectId: { object: "Domain", id }, linkedObjects: objects },
  });

describe("linkedDkimKeys", () => {
  it("returns the DKIM key ids a refusal names for the domain", () => {
    expect(linkedDkimKeys(linked("d1", [{ object: "DkimSignature", id: "k1" }]), "d1")).toEqual(["k1"]);
  });

  it("is null when anything other than a DKIM key is linked", () => {
    const err = linked("d1", [
      { object: "DkimSignature", id: "k1" },
      { object: "Account", id: "a1" },
    ]);
    expect(linkedDkimKeys(err, "d1")).toBeNull();
  });

  it("is null for another domain, another refusal, an empty list or a non-Stalwart error", () => {
    expect(linkedDkimKeys(linked("d1", [{ object: "DkimSignature", id: "k1" }]), "d2")).toBeNull();
    expect(linkedDkimKeys(new StalwartError("x", "set", { d1: { type: "forbidden" } }), "d1")).toBeNull();
    expect(linkedDkimKeys(linked("d1", []), "d1")).toBeNull();
    expect(linkedDkimKeys(new StalwartError("x", "http"), "d1")).toBeNull();
    expect(linkedDkimKeys(new Error("boom"), "d1")).toBeNull();
  });
});

/** A transport whose domain destroy is refused `refusals` times, each time naming a key added since the list. */
function fakeTransport(refusals: number, other = false) {
  const destroyed: string[][] = [];
  let left = refusals;
  const transport = {
    getAll: () =>
      Promise.resolve([
        { id: "k0", domainId: "d1" },
        { id: "x", domainId: "d9" },
      ]),
    set: (object: string, args: { destroy: string[] }) => {
      if (object === "x:DkimSignature") {
        destroyed.push(args.destroy);
        return Promise.resolve({});
      }
      if (left > 0) {
        left--;
        const objects = other
          ? [{ object: "Account", id: "a1" }]
          : [{ object: "DkimSignature", id: `k${String(refusals - left)}` }];
        return Promise.reject(linked("d1", objects));
      }
      return Promise.resolve({});
    },
  } as unknown as StalwartTransport;
  return { mgmt: new StalwartManagement(transport), destroyed };
}

describe("destroyDomain", () => {
  it("destroys the domain's own keys first, then the domain", async () => {
    const { mgmt, destroyed } = fakeTransport(0);
    await mgmt.destroyDomain("d1");
    expect(destroyed).toEqual([["k0"]]);
  });

  it("destroys a key added between the list and the destroy, then tries again", async () => {
    const { mgmt, destroyed } = fakeTransport(1);
    await mgmt.destroyDomain("d1");
    expect(destroyed).toEqual([["k0"], ["k1"]]);
  });

  it("gives up after a bounded number of attempts", async () => {
    const { mgmt } = fakeTransport(5);
    await expect(mgmt.destroyDomain("d1")).rejects.toThrow("notDestroyed");
  });

  it("does not retry when something other than a DKIM key is linked", async () => {
    const { mgmt, destroyed } = fakeTransport(1, true);
    await expect(mgmt.destroyDomain("d1")).rejects.toThrow("notDestroyed");
    expect(destroyed).toEqual([["k0"]]);
  });
});
