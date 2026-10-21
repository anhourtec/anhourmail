// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { deps, req } from "../__tests__/helpers";
import { recordSecurityEvent } from "./service";

describe("recordSecurityEvent", () => {
  it("audits as the identity system with a masked label", async () => {
    const d = deps();
    await recordSecurityEvent(d, { action: "auth.password_reset", userId: "u1", email: "kim@example.com" }, req);
    const [entry] = d.uow.state.audit;
    expect(entry).toMatchObject({
      action: "auth.password_reset",
      result: "success",
      actor: { type: "system", email: "identity" },
      target: { type: "user", id: "u1", label: "k***@example.com" },
    });
  });
});
