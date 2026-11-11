// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import type { StalwartManagement } from "./management";
import {
  applySendingPolicy,
  coveredSender,
  desiredMaxRecipients,
  desiredThrottles,
  SENDING_THROTTLE_DESCRIPTIONS,
  type SendingPolicy,
  sendingPolicyDrift,
} from "./sending";

const POLICY: SendingPolicy = {
  messagesPerHour: 50,
  messagesPerDay: 200,
  recipientsPerMessage: 50,
  otherRecipientsPerMessage: 100,
  exempt: { domain: "platform.test", localParts: ["no-reply", "postmaster"] },
};

type Row = Record<string, unknown> & { id: string };

/** A fake management client holding the throttles and the RCPT stage, recording every write and reload. */
function fake(throttles: Row[] = [], maxRecipients: unknown = { match: {}, else: "100" }) {
  const state = { throttles: [...throttles], maxRecipients, sets: [] as unknown[], reloads: 0, next: 1 };
  const mgmt = {
    transport: {
      getAll: async (object: string) => {
        if (object === "x:MtaInboundThrottle") return state.throttles.map((t) => ({ ...t }));
        if (object === "x:MtaStageRcpt") return [{ id: "singleton", maxRecipients: state.maxRecipients }];
        throw new Error(`unexpected ${object}`);
      },
      set: async (object: string, args: Record<string, unknown>) => {
        state.sets.push({ object, args });
        const created: Record<string, { id: string }> = {};
        for (const [k, v] of Object.entries((args.create ?? {}) as Record<string, Row>)) {
          const id = `n${String(state.next++)}`;
          state.throttles.push({ ...v, id });
          created[k] = { id };
        }
        for (const [id, v] of Object.entries((args.update ?? {}) as Record<string, Row>)) {
          state.throttles = state.throttles.map((t) => (t.id === id ? { ...v, id } : t));
        }
        const destroy = (args.destroy ?? []) as string[];
        state.throttles = state.throttles.filter((t) => !destroy.includes(t.id));
        return { created };
      },
    },
    updateSingleton: async (object: string, fields: Record<string, unknown>) => {
      state.sets.push({ object, fields });
      state.maxRecipients = fields.maxRecipients;
    },
    reloadSettings: async () => {
      state.reloads += 1;
    },
  } as unknown as StalwartManagement;
  return { mgmt, state };
}

const other: Row = {
  id: "default",
  description: "Sender IP throttle",
  enable: true,
  key: { remoteIp: true },
  match: { match: {}, else: "true" },
  rate: { count: 5, period: 1000 },
};

describe("the authenticated-sender ceiling", () => {
  it("covers authenticated sessions except the exempt system accounts", () => {
    expect(coveredSender(POLICY)).toBe(
      "!is_empty(authenticated_as) && !(authenticated_as == 'no-reply@platform.test' || authenticated_as == 'postmaster@platform.test')",
    );
    expect(coveredSender({ ...POLICY, exempt: { domain: "platform.test", localParts: [] } })).toBe(
      "!is_empty(authenticated_as)",
    );
  });

  it("refuses values that aren't plain names or positive whole numbers", () => {
    for (const bad of [
      { ...POLICY, exempt: { domain: "x' || true || '", localParts: [] } },
      { ...POLICY, exempt: { domain: "platform.test", localParts: ["a'b"] } },
      { ...POLICY, messagesPerHour: 0 },
      { ...POLICY, messagesPerDay: 1.5 },
    ]) {
      expect(() => coveredSender(bad)).toThrow(/sending policy/);
    }
  });

  it("builds an hourly and a daily throttle keyed by the authenticated account, and the RCPT cap", () => {
    const [hour, day] = desiredThrottles(POLICY);
    expect(hour).toMatchObject({
      description: SENDING_THROTTLE_DESCRIPTIONS.hour,
      key: { authenticatedAs: true },
      rate: { count: 50, period: 3_600_000 },
      enable: true,
    });
    expect(day).toMatchObject({ rate: { count: 200, period: 86_400_000 } });
    expect(desiredMaxRecipients(POLICY)).toEqual({
      match: { "0": { if: coveredSender(POLICY), then: "50" } },
      else: "100",
    });
  });

  it("creates what is missing, then is idempotent: a second run writes nothing and doesn't reload", async () => {
    const { mgmt, state } = fake([other]);
    expect(await sendingPolicyDrift(mgmt, POLICY)).toEqual([
      "throttle-hour-missing",
      "throttle-day-missing",
      "max-recipients-changed",
    ]);
    expect(await applySendingPolicy(mgmt, POLICY)).toEqual({
      created: 2,
      updated: 0,
      removed: 0,
      recipientsChanged: true,
    });
    expect(state.reloads).toBe(1);
    expect(state.throttles.map((t) => t.description)).toEqual([
      "Sender IP throttle",
      SENDING_THROTTLE_DESCRIPTIONS.hour,
      SENDING_THROTTLE_DESCRIPTIONS.day,
    ]);
    expect(await sendingPolicyDrift(mgmt, POLICY)).toEqual([]);
    const writes = state.sets.length;
    expect(await applySendingPolicy(mgmt, POLICY)).toEqual({
      created: 0,
      updated: 0,
      removed: 0,
      recipientsChanged: false,
    });
    expect(state.sets.length).toBe(writes);
    expect(state.reloads).toBe(1);
  });

  it("corrects changed numbers, removes a duplicate of ours and never touches another throttle", async () => {
    const [hour, day] = desiredThrottles(POLICY);
    const { mgmt, state } = fake(
      [
        other,
        { ...hour, id: "h1", rate: { count: 500, period: 3_600_000 } },
        { ...hour, id: "h2" },
        { ...day, id: "d1", enable: false },
      ],
      desiredMaxRecipients(POLICY),
    );
    expect(await sendingPolicyDrift(mgmt, POLICY)).toEqual([
      "throttle-hour-changed",
      "throttle-hour-duplicate",
      "throttle-day-changed",
    ]);
    expect(await applySendingPolicy(mgmt, POLICY)).toEqual({
      created: 0,
      updated: 2,
      removed: 1,
      recipientsChanged: false,
    });
    expect(state.throttles.find((t) => t.id === "default")).toEqual(other);
    // Changed ones are replaced whole (a description can't be updated on the server); one of each is left.
    expect(state.throttles.map((t) => t.description).sort()).toEqual(
      ["Sender IP throttle", SENDING_THROTTLE_DESCRIPTIONS.day, SENDING_THROTTLE_DESCRIPTIONS.hour].sort(),
    );
    expect(state.throttles.some((t) => ["h1", "h2", "d1"].includes(t.id))).toBe(false);
    expect(await sendingPolicyDrift(mgmt, POLICY)).toEqual([]);
  });

  it("reads a throttle keyed on more than the account, or a changed match, as changed", async () => {
    const [hour, day] = desiredThrottles(POLICY);
    const { mgmt } = fake(
      [
        { ...hour, id: "h", key: { authenticatedAs: true, remoteIp: true } },
        { ...day, id: "d", match: { match: {}, else: "true" } },
      ],
      { match: { "0": { if: "true", then: "50" } }, else: "100" },
    );
    expect(await sendingPolicyDrift(mgmt, POLICY)).toEqual([
      "throttle-hour-changed",
      "throttle-day-changed",
      "max-recipients-changed",
    ]);
  });
});
