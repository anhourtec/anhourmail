// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES, normalizePreferences, parsePreferencePatch } from "./webmail";

describe("webmail preferences", () => {
  it("fills every missing or invalid field with its default and drops unknown keys", () => {
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences("nope")).toEqual(DEFAULT_PREFERENCES);
    const p = normalizePreferences({
      density: "compact",
      previewLines: 7,
      timeZone: "America/Vancouver",
      startIn: "folder:abc_1",
      __proto__: { theme: "dark" },
      evil: true,
    });
    expect(p.density).toBe("compact");
    expect(p.previewLines).toBe(DEFAULT_PREFERENCES.previewLines);
    expect(p.timeZone).toBe("America/Vancouver");
    expect(p.startIn).toBe("folder:abc_1");
    expect(p.theme).toBe("system");
    expect(Object.keys(p)).not.toContain("evil");
  });

  it("accepts a patch only when every key and value is allowed", () => {
    expect(parsePreferencePatch({ density: "roomy", undoSeconds: 30 })).toEqual({ density: "roomy", undoSeconds: 30 });
    expect(parsePreferencePatch({ density: "huge" })).toBeNull();
    expect(parsePreferencePatch({ undoSeconds: 60 })).toBeNull();
    expect(parsePreferencePatch({ density: "roomy", other: 1 })).toBeNull();
    expect(parsePreferencePatch({})).toBeNull();
    expect(parsePreferencePatch([])).toBeNull();
    expect(parsePreferencePatch({ timeZone: "../../etc" })).toBeNull();
    expect(parsePreferencePatch({ startIn: "folder:" })).toBeNull();
    expect(parsePreferencePatch({ toString: "x" })).toBeNull();
  });
});
