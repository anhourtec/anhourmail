// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { asctime, type ExportSource, folderPaths, GATE_EVERY, mailExportStream, mboxEntry } from "./export";
import type { WebmailSession } from "./session-store";

/** A mailbox with one folder of `count` messages; `blockAfter` gate checks pass, then the mailbox is blocked. */
function source(count: number, blockAfter: number): ExportSource & { gateChecks: () => number } {
  let checks = 0;
  const session: WebmailSession = {
    username: "me@x.test",
    accountId: "acc",
    accessToken: "t",
    refreshToken: null,
    expiresAt: Date.now() + 3_600_000,
    createdAt: Date.now(),
  };
  return {
    gateChecks: () => checks,
    session: async () => session,
    blockedReason: async () => {
      checks += 1;
      return checks > blockAfter ? "suspended" : null;
    },
    exportContacts: async () => "",
    download: async () => new Response("Subject: x\r\n\r\nhello\r\n"),
    jmapAs: async (_id, build) => {
      const body = build(session) as { methodCalls: [string, Record<string, unknown>, string][] };
      const first = body.methodCalls[0];
      const name = first?.[0] ?? "";
      const args: Record<string, unknown> = first?.[1] ?? {};
      if (name === "Mailbox/get") {
        return {
          methodResponses: [
            ["Mailbox/get", { list: [{ id: "f1", name: "Inbox", parentId: null, role: "inbox" }] }, "m"],
          ],
        };
      }
      const position = Number(args.position);
      const n = Math.max(0, Math.min(100, count - position));
      const list = Array.from({ length: n }, (_, i) => ({
        id: `e${String(position + i)}`,
        blobId: "b",
        receivedAt: "2026-10-29T00:00:00Z",
        size: 1,
      }));
      return {
        methodResponses: [
          ["Email/query", {}, "q"],
          ["Email/get", { list }, "g"],
        ],
      };
    },
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<"done" | "error"> {
  const reader = stream.getReader();
  try {
    for (;;) if ((await reader.read()).done) return "done";
  } catch {
    return "error";
  }
}

describe("mail export helpers", () => {
  it("asks the access gate before each folder and every GATE_EVERY messages, and stops when the mailbox is blocked", async () => {
    const ok = source(120, 100);
    let summary: { complete: boolean; messages: number } | null = null;
    expect(
      await drain(
        await mailExportStream(ok, "s", {}, async (_a, s) => {
          summary = s;
        }),
      ),
    ).toBe("done");
    // Before the folder, after 50 and 100 messages, before the contacts.
    expect(ok.gateChecks()).toBe(4);
    await new Promise((r) => setTimeout(r, 10));
    expect(summary).toMatchObject({ complete: true, messages: 120 });

    const blocked = source(120, 1); // suspended after the first check
    let stopped: { complete: boolean; messages: number } | null = null;
    expect(
      await drain(
        await mailExportStream(blocked, "s", {}, async (_a, s) => {
          stopped = s;
        }),
      ),
    ).toBe("error");
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toMatchObject({ complete: false, messages: GATE_EVERY });
  });

  it("writes the mbox separator date in asctime form (UTC)", () => {
    expect(asctime(new Date("2026-10-29T08:05:09Z"))).toBe("Thu Oct 29 08:05:09 2026");
    expect(asctime(new Date("2026-01-02T23:59:59Z"))).toBe("Fri Jan  2 23:59:59 2026");
  });

  it("quotes From lines once more (mboxrd), keeps the bytes and ends with a blank line", () => {
    const src = Buffer.from("Subject: x\r\n\r\nFrom here\r\n>From there\r\nnot From\r\n\xe9", "latin1");
    const out = mboxEntry(src, new Date("2026-10-29T08:05:09Z")).toString("latin1");
    expect(out.startsWith("From MAILER-DAEMON Thu Oct 29 08:05:09 2026\n")).toBe(true);
    expect(out).toContain("\r\n>From here\r\n>>From there\r\nnot From\r\n\xe9\n\n");
    expect(mboxEntry(Buffer.from("a\n"), new Date(0)).toString().endsWith("a\n\n")).toBe(true);
  });

  it("names folder files by their path, safely, without clashes", () => {
    const paths = folderPaths([
      { id: "1", name: "Inbox", parentId: null, role: "inbox" },
      { id: "2", name: "Work", parentId: null, role: null },
      { id: "3", name: "2026/Q4", parentId: "2", role: null },
      { id: "4", name: "work", parentId: null, role: null },
      { id: "5", name: "../../etc", parentId: null, role: null },
      { id: "6", name: "Loop", parentId: "6", role: null },
    ]);
    expect([...paths.values()]).toEqual([
      "mail/Inbox",
      "mail/Work",
      "mail/Work/2026_Q4",
      "mail/work (2)",
      "mail/_.._etc",
      expect.stringMatching(/^mail\/(Loop\/)+Loop$/),
    ]);
  });
});
