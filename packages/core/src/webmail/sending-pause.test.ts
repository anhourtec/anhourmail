// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { inspectManagedScript } from "./managed-script";
import {
  applySendingPause,
  liftSendingPause,
  outboundCommands,
  PAUSE_OPEN,
  pauseModeFor,
  redirectTargets,
  unpausedOutbound,
} from "./sending-pause";

const SCRIPT = [
  'require ["envelope", "vacation", "copy", "fileinto"];',
  "# AnhourMail settings, managed by the webmail.",
  "# am-settings: abc",
  "",
  'if not header :contains "X-Spam-Status" "Yes" {',
  '  vacation :days 3 :subject "Away" "Back soon.\nredirect \\"no@where.test\\"; vacation";',
  '  redirect :copy "Friend@Outside.example";',
  "}",
  'if header :contains "subject" "redirect" {',
  '  redirect :copy "colleague@hosted.test";',
  '  fileinto "Work";',
  "}",
  '# redirect "commented@outside.example";',
  "",
].join("\n");

const outside = (a: string) => !a.endsWith("@hosted.test");

describe("pauseModeFor", () => {
  it("pauses everything while restricted, replies and outside redirects while new, nothing otherwise", () => {
    expect(pauseModeFor("restricted")).toBe("all");
    expect(pauseModeFor("new")).toBe("external");
    expect(pauseModeFor("standard")).toBe("none");
    expect(pauseModeFor("trusted")).toBe("none");
  });
});

describe("outboundCommands", () => {
  it("finds code commands only, never words in strings or comments, with redirect targets", () => {
    const found = outboundCommands(SCRIPT);
    expect(found.map((c) => [c.kind, c.target, c.paused])).toEqual([
      ["vacation", null, false],
      ["redirect", "friend@outside.example", false],
      ["redirect", "colleague@hosted.test", false],
    ]);
    expect(redirectTargets(SCRIPT)).toEqual(["friend@outside.example", "colleague@hosted.test"]);
  });

  it("a redirect whose target isn't one plain string has no target", () => {
    expect(outboundCommands('redirect ["a@b.test", "c@d.test"];')[0]?.target).toBeNull();
    expect(outboundCommands('redirect "a@b.test" "x";')[0]?.target).toBeNull();
  });

  it("ignores a keyword without its terminating semicolon", () => {
    expect(outboundCommands("redirect")).toEqual([]);
  });
});

describe("applySendingPause", () => {
  it("restricted: pauses every redirect and vacation, keeps the settings line, and lifts back exactly", () => {
    const paused = applySendingPause(SCRIPT, "all", outside);
    expect(paused.split(PAUSE_OPEN).length - 1).toBe(3);
    expect(paused).toContain("# am-settings: abc");
    expect(paused).toContain('  fileinto "Work";');
    expect(outboundCommands(paused).every((c) => c.paused)).toBe(true);
    expect(unpausedOutbound(paused, "all", outside)).toBe(0);
    expect(liftSendingPause(paused)).toBe(SCRIPT);
    // Idempotent.
    expect(applySendingPause(paused, "all", outside)).toBe(paused);
  });

  it("new: pauses redirects to outside addresses and every automatic reply; internal forwarding stays", () => {
    const held = applySendingPause(SCRIPT, "external", outside);
    expect(outboundCommands(held).map((c) => [c.kind, c.paused])).toEqual([
      ["vacation", true],
      ["redirect", true],
      ["redirect", false],
    ]);
    expect(unpausedOutbound(held, "external", outside)).toBe(0);
    expect(unpausedOutbound(SCRIPT, "external", outside)).toBe(2);
    // Lifting gives back exactly the script that was written (finding F4: the reply comes back with Standard).
    expect(liftSendingPause(held)).toBe(SCRIPT);
    expect(applySendingPause(held, "none", outside)).toBe(SCRIPT);
    expect(applySendingPause(held, "external", outside)).toBe(held);
  });

  it("new: a contacts-only automatic reply is paused too (no extlists; the owner picks the contacts)", () => {
    const text = [
      'require ["envelope", "vacation"];',
      'if envelope :all :comparator "i;unicode-casemap" :is "from" ["friend@outside.example"] {',
      '    vacation :days 3 "Away";',
      "  }",
      "",
    ].join("\n");
    const held = applySendingPause(text, "external", outside);
    expect(outboundCommands(held).map((c) => [c.kind, c.paused])).toEqual([["vacation", true]]);
    expect(liftSendingPause(held)).toBe(text);
  });

  it("moves between modes exactly, and none lifts everything", () => {
    const held = applySendingPause(SCRIPT, "external", outside);
    const restricted = applySendingPause(held, "all", outside);
    expect(restricted).toBe(applySendingPause(SCRIPT, "all", outside));
    expect(applySendingPause(restricted, "external", outside)).toBe(held);
    expect(applySendingPause(restricted, "none", outside)).toBe(SCRIPT);
    expect(unpausedOutbound(SCRIPT, "none", outside)).toBe(0);
  });

  it("treats a redirect it can't read as outside", () => {
    const text = 'redirect ["a@hosted.test", "b@x.test"];';
    expect(outboundCommands(applySendingPause(text, "external", outside))[0]?.paused).toBe(true);
  });

  it("a marker inside a reply text is just text: nothing is lifted from it", () => {
    const text = `vacation "${PAUSE_OPEN}redirect \\"x@y.test\\";\n}";`;
    expect(liftSendingPause(text)).toBe(text);
    expect(outboundCommands(text)).toHaveLength(1);
  });

  it("the reconciler's inspection reads a paused script as the script it was", () => {
    const paused = applySendingPause(SCRIPT, "all", outside);
    expect(inspectManagedScript(paused)).toEqual(inspectManagedScript(SCRIPT));
  });
});
