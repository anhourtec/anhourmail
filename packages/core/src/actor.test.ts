// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, anonymous, user } from "./__tests__/helpers";
import { authorize, can } from "./actor";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "./errors";

describe("can / authorize", () => {
  it("anonymous gets 401 for everything", () => {
    expect(() => {
      authorize(anonymous, "self.profile.read");
    }).toThrow(UnauthenticatedError);
    expect(() => {
      authorize(anonymous, "platform.audit.read");
    }).toThrow(UnauthenticatedError);
    expect(() => {
      authorize(anonymous, "audit.read", ACCOUNT_A);
    }).toThrow(UnauthenticatedError);
  });

  it("system actors can do anything", () => {
    expect(can({ kind: "system", name: "worker" }, "platform.staff.manage")).toBe(true);
  });

  it("self permissions need a signed-in, unsuspended user", () => {
    expect(can(user(), "self.security.manage")).toBe(true);
    expect(can(user({ suspended: true }), "self.security.manage")).toBe(false);
  });

  it("platform permissions follow platform roles", () => {
    expect(can(user({ platform: ["reports_reader"] }), "platform.audit.read")).toBe(true);
    expect(can(user({ platform: ["reports_reader"] }), "platform.staff.manage")).toBe(false);
    expect(() => {
      authorize(user({ platform: ["billing_admin"] }), "platform.audit.read");
    }).toThrow(ForbiddenError);
  });

  it("account permissions need membership in that account: 404 outside, 403 inside without the role", () => {
    const member = user({ account: [[ACCOUNT_A, "member"]] });
    expect(() => {
      authorize(member, "audit.read", ACCOUNT_B);
    }).toThrow(NotFoundError);
    expect(() => {
      authorize(member, "audit.read", ACCOUNT_A);
    }).toThrow(ForbiddenError);
    const owner = user({ account: [[ACCOUNT_A, "owner"]] });
    expect(() => {
      authorize(owner, "audit.read", ACCOUNT_A);
    }).not.toThrow();
    expect(() => {
      authorize(owner, "audit.read", ACCOUNT_B);
    }).toThrow(NotFoundError);
  });

  it("account permissions without an account id are refused", () => {
    expect(can(user({ account: [[ACCOUNT_A, "owner"]] }), "audit.read")).toBe(false);
    expect(() => {
      authorize(user({ account: [[ACCOUNT_A, "owner"]] }), "audit.read");
    }).toThrow(NotFoundError);
  });

  it("staff roles do not grant account permissions", () => {
    expect(can(user({ platform: ["global_admin"] }), "audit.read", ACCOUNT_A)).toBe(false);
  });

  it("suspended users are refused everywhere", () => {
    const s = user({ platform: ["global_admin"], account: [[ACCOUNT_A, "owner"]], suspended: true });
    expect(can(s, "platform.audit.read")).toBe(false);
    expect(can(s, "audit.read", ACCOUNT_A)).toBe(false);
    expect(can(s, "self.profile.read")).toBe(false);
  });
});
