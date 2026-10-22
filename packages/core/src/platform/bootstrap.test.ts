// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { deps as makeDeps, fixedClock, req } from "../__tests__/helpers";
import { ValidationError } from "../errors";
import { bootstrapPlatformAdmin, SET_PASSWORD_LINK_MINUTES } from "./bootstrap";

const input = { email: "  First.Admin@Example.org ", firstName: "First", lastName: "Admin" };

describe("bootstrapPlatformAdmin", () => {
  it("creates a password-less Global Administrator with a one-hour set-password token, audited", async () => {
    const d = makeDeps(fixedClock("2026-10-22T12:00:00Z"));
    const out = await bootstrapPlatformAdmin(d, input, req);
    if (out.status !== "created") throw new Error("expected created");

    expect(out.email).toBe("first.admin@example.org");
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.expiresAt.toISOString()).toBe(
      new Date(Date.parse("2026-10-22T12:00:00Z") + SET_PASSWORD_LINK_MINUTES * 60_000).toISOString(),
    );
    const s = d.uow.state;
    expect(s.userEmails[out.userId]).toBe("first.admin@example.org");
    expect(s.userNames[out.userId]).toBe("First Admin");
    expect(s.logins).toEqual([]); // no password until they set one
    expect(s.platformRoles).toEqual([{ userId: out.userId, role: "global_admin" }]);
    expect(s.passwordSetTokens).toEqual([{ userId: out.userId, token: out.token, expiresAt: out.expiresAt }]);

    expect(s.audit).toHaveLength(1);
    expect(s.audit[0]).toMatchObject({
      scope: "platform",
      action: "platform.admin_bootstrapped",
      result: "success",
      actor: { type: "system", email: "bootstrap-admin", userId: null },
      target: { type: "user", id: out.userId, label: "first.admin@example.org" },
      meta: { role: "global_admin", linkExpiresAt: out.expiresAt.toISOString() },
    });
    // The token (and so the link) never reaches the audit log.
    expect(JSON.stringify(s.audit)).not.toContain(out.token);
  });

  it("refuses, audited as denied, once anyone holds a platform role", async () => {
    const d = makeDeps();
    d.uow.state.platformRoles.push({ userId: "someone", role: "support_admin" });
    expect(await bootstrapPlatformAdmin(d, input, req)).toEqual({ status: "refused", reason: "admin_exists" });
    expect(Object.keys(d.uow.state.userEmails)).toEqual([]);
    expect(d.uow.state.passwordSetTokens).toEqual([]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "platform.admin_bootstrapped",
      result: "denied",
      errorCode: "admin_exists",
      actor: { type: "system" },
    });
  });

  it("refuses a second run: there is only ever one bootstrap", async () => {
    const d = makeDeps();
    expect((await bootstrapPlatformAdmin(d, input, req)).status).toBe("created");
    const again = await bootstrapPlatformAdmin(d, { ...input, email: "other@example.org" }, req);
    expect(again).toEqual({ status: "refused", reason: "admin_exists" });
    expect(d.uow.state.platformRoles).toHaveLength(1);
  });

  it("lets only one of two concurrent runs through", async () => {
    const d = makeDeps();
    const results = await Promise.all([
      bootstrapPlatformAdmin(d, input, req),
      bootstrapPlatformAdmin(d, { ...input, email: "second@example.org" }, req),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["created", "refused"]);
    expect(d.uow.state.platformRoles).toHaveLength(1);
  });

  it("never promotes an existing console login", async () => {
    const d = makeDeps();
    d.uow.state.userEmails["pre-registered"] = "first.admin@example.org";
    expect(await bootstrapPlatformAdmin(d, input, req)).toEqual({ status: "refused", reason: "login_exists" });
    expect(d.uow.state.platformRoles).toEqual([]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "login_exists" });
  });

  it("validates the email and first name before writing anything", async () => {
    const d = makeDeps();
    await expect(bootstrapPlatformAdmin(d, { ...input, email: "not-an-email" }, req)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(bootstrapPlatformAdmin(d, { ...input, firstName: "  " }, req)).rejects.toBeInstanceOf(ValidationError);
    expect(d.uow.state.audit).toEqual([]);
    expect(d.uow.state.platformRoles).toEqual([]);
  });

  it("records a failed attempt and keeps nothing when a write fails", async () => {
    const d = makeDeps();
    const uow = {
      run: <T>(fn: Parameters<typeof d.uow.run<T>>[0]) =>
        d.uow.run((r) =>
          fn({ ...r, staff: { ...r.staff, issuePasswordSetToken: () => Promise.reject(new Error("db down")) } }),
        ),
    };
    await expect(bootstrapPlatformAdmin({ ...d, uow }, input, req)).rejects.toThrow("db down");
    expect(d.uow.state.platformRoles).toEqual([]);
    expect(Object.keys(d.uow.state.userEmails)).toEqual([]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "platform.admin_bootstrapped", result: "failed" });
  });
});
