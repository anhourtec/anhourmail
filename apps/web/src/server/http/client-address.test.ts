// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { runWithRequestContext } from "@anhourmail/server/request-context";

import { currentClientAddress } from "./client-address";

describe("currentClientAddress", () => {
  it("is what route() derived for the request, null included", async () => {
    expect(
      await runWithRequestContext({ requestId: "r1", clientIp: "198.51.100.30" }, () => currentClientAddress()),
    ).toBe("198.51.100.30");
    expect(await runWithRequestContext({ requestId: "r2", clientIp: null }, () => currentClientAddress())).toBeNull();
  });

  it("is null outside any request", async () => {
    expect(await currentClientAddress()).toBeNull();
  });
});
