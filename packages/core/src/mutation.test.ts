// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, anonymous, deps, req, user } from "./__tests__/helpers";
import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "./errors";
import { mutation } from "./mutation";

const spec = (accountId: string | null) =>
  ({ action: "domain.added", permission: "domain.manage", accountId, target: { type: "domain" } }) as const;

describe("mutation()", () => {
  it("runs the change and appends a success entry in the same unit of work", async () => {
    const d = deps();
    const result = await mutation(d, user({ account: [[ACCOUNT_A, "owner"]] }), req, spec(ACCOUNT_A), async () => ({
      result: 42,
      target: { id: "dom-1", label: "example.test" },
      meta: { password: "secret", note: "ok" },
    }));
    expect(result).toBe(42);
    const [entry] = await d.uow.run((r) => r.audit.chain(`account:${ACCOUNT_A}`));
    expect(entry).toMatchObject({
      action: "domain.added",
      result: "success",
      target: { type: "domain", id: "dom-1", label: "example.test" },
      requestId: req.requestId,
      ip: req.ip,
      meta: { password: "[redacted]", note: "ok" },
    });
  });

  it("audits a 403 in the account's own log and rethrows", async () => {
    const d = deps();
    await expect(
      mutation(d, user({ account: [[ACCOUNT_A, "member"]] }), req, spec(ACCOUNT_A), async () => ({ result: 1 })),
    ).rejects.toThrow(ForbiddenError);
    const [entry] = await d.uow.run((r) => r.audit.chain(`account:${ACCOUNT_A}`));
    expect(entry).toMatchObject({ result: "denied", errorCode: "forbidden" });
  });

  it("audits 404 probes and 401s in the platform log, never the target account's", async () => {
    const d = deps();
    await expect(
      mutation(d, user({ account: [[ACCOUNT_B, "owner"]] }), req, spec(ACCOUNT_A), async () => ({ result: 1 })),
    ).rejects.toThrow(NotFoundError);
    await expect(mutation(d, anonymous, req, spec(ACCOUNT_A), async () => ({ result: 1 }))).rejects.toThrow(
      UnauthenticatedError,
    );
    expect(await d.uow.run((r) => r.audit.chain(`account:${ACCOUNT_A}`))).toEqual([]);
    const platform = await d.uow.run((r) => r.audit.chain("platform"));
    expect(platform.map((e) => e.errorCode)).toEqual(["not_found", "unauthorized"]);
  });

  it("rolls back the change and records a failed entry when the handler throws", async () => {
    const d = deps();
    await expect(
      mutation(d, user({ account: [[ACCOUNT_A, "owner"]] }), req, spec(ACCOUNT_A), async (r) => {
        await r.audit.append(
          {
            scope: `account:${ACCOUNT_A}`,
            action: "alias.created",
            actor: { type: "system", userId: null, email: null, role: null, accountId: null },
            onBehalfOf: null,
            target: { type: "x", id: null, label: null },
            result: "success",
            errorCode: null,
            requestId: null,
            ip: null,
            userAgent: null,
            meta: {},
          },
          new Date(),
        );
        throw new ValidationError("nope");
      }),
    ).rejects.toThrow(ValidationError);
    const chain = await d.uow.run((r) => r.audit.chain(`account:${ACCOUNT_A}`));
    expect(chain.map((e) => [e.action, e.result, e.errorCode])).toEqual([["domain.added", "failed", "bad_request"]]);
  });

  it("records unexpected errors as server_error", async () => {
    const d = deps();
    await expect(
      mutation(d, user({ account: [[ACCOUNT_A, "owner"]] }), req, spec(ACCOUNT_A), async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
    const [entry] = await d.uow.run((r) => r.audit.chain(`account:${ACCOUNT_A}`));
    expect(entry?.errorCode).toBe("server_error");
  });

  it("business refusals are audited as denied but return the result", async () => {
    const d = deps();
    const system = { kind: "system", name: "test" } as const;
    const out = await mutation(d, system, req, { ...spec(null), permission: "self.profile.read" }, async () => ({
      result: "ok",
      denied: { code: "bot_check" },
    }));
    expect(out).toBe("ok");
    const [entry] = await d.uow.run((r) => r.audit.chain("platform"));
    expect(entry).toMatchObject({ result: "denied", errorCode: "bot_check" });
  });

  it("writes the `also` entries after the main one, in the same unit of work, in their own scope when given", async () => {
    const d = deps();
    await mutation(d, user({ account: [[ACCOUNT_A, "owner"]] }), req, spec(ACCOUNT_A), async () => ({
      result: 1,
      target: { id: "dom-1" },
      also: [
        { action: "delegation.revoked", target: { type: "mailbox", id: "mbx-1" }, meta: { token: "t", right: "x" } },
        { action: "delegation.granted", accountId: ACCOUNT_B, target: { type: "mailbox", label: "a@b" }, meta: {} },
        { action: "delegation.granted", accountId: null, target: { type: "mailbox" }, meta: {} },
      ],
    }));
    const chain = await d.uow.run((r) => r.audit.chain(`account:${ACCOUNT_A}`));
    expect(chain.map((e) => [e.action, e.result, e.target.id, e.requestId])).toEqual([
      ["domain.added", "success", "dom-1", req.requestId],
      ["delegation.revoked", "success", "mbx-1", req.requestId],
    ]);
    expect(chain[1]?.meta).toEqual({ token: "[redacted]", right: "x" });
    expect(chain[1]?.actor).toEqual(chain[0]?.actor);
    const inB = await d.uow.run((r) => r.audit.chain(`account:${ACCOUNT_B}`));
    expect(inB.map((e) => [e.action, e.target.label])).toEqual([["delegation.granted", "a@b"]]);
    expect((await d.uow.run((r) => r.audit.chain("platform"))).map((e) => e.action)).toEqual(["delegation.granted"]);
  });
});
