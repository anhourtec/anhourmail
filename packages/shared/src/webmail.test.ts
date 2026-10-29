// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES, isSenderKey, normalizePreferences, parsePreferencePatch, REMOTE_IMAGES } from "./webmail";

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

describe("remote image preferences", () => {
  const key = "A".repeat(21) + "b";
  it("defaults to asking, with nobody remembered", () => {
    expect(DEFAULT_PREFERENCES.remoteImages).toBe("ask");
    expect(normalizePreferences({}).imageSenders).toEqual([]);
    // Every result has its own list (the default's is never shared).
    expect(normalizePreferences({}).imageSenders).not.toBe(normalizePreferences({}).imageSenders);
  });

  it("accepts the modes and remembered sender keys, nothing else", () => {
    expect(parsePreferencePatch({ remoteImages: "contacts" })).toEqual({ remoteImages: "contacts" });
    expect(parsePreferencePatch({ remoteImages: "sometimes" })).toBeNull();
    expect(parsePreferencePatch({ imageSenders: [key] })).toEqual({ imageSenders: [key] });
    expect(parsePreferencePatch({ imageSenders: [] })).toEqual({ imageSenders: [] });
    // Addresses, duplicates, other shapes and too many entries are refused.
    expect(parsePreferencePatch({ imageSenders: ["sam@example.test"] })).toBeNull();
    expect(parsePreferencePatch({ imageSenders: [key, key] })).toBeNull();
    expect(parsePreferencePatch({ imageSenders: key })).toBeNull();
    expect(parsePreferencePatch({ imageSenders: [1] })).toBeNull();
    const many = Array.from({ length: REMOTE_IMAGES.maxSenders + 1 }, (_, i) => String(i).padStart(22, "x"));
    expect(parsePreferencePatch({ imageSenders: many })).toBeNull();
    expect(parsePreferencePatch({ imageSenders: many.slice(1) })).not.toBeNull();
    expect(isSenderKey(key)).toBe(true);
    expect(isSenderKey(`${key}=`)).toBe(false);
  });

  it("keeps stored remembered senders and drops a damaged list", () => {
    expect(normalizePreferences({ imageSenders: [key], remoteImages: "always" })).toMatchObject({
      imageSenders: [key],
      remoteImages: "always",
    });
    expect(normalizePreferences({ imageSenders: ["bad"] }).imageSenders).toEqual([]);
  });
});
