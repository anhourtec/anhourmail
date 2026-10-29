// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { cleanOutgoingCss, fontAttribute, isSafeColor } from "@/server/webmail/outgoing-html";

import {
  ALIGNMENTS,
  alignmentOf,
  colourHex,
  FONT_FAMILIES,
  FONT_SIZES,
  HIGHLIGHTS,
  matchFamily,
  matchSize,
  TEXT_COLOURS,
  writesCss,
} from "./format-options";

/** How the browser writes a `#rrggbb` colour into the editor. */
const asRgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String(n >> 16)}, ${String((n >> 8) & 255)}, ${String(n & 255)})`;
};

describe("format options survive the outgoing sanitiser", () => {
  it.each(FONT_FAMILIES.map((f) => f.value))("keeps font-family: %s", (v) => {
    expect(cleanOutgoingCss(`font-family: ${v}`).css).toBe(`font-family: ${v}`);
    expect(fontAttribute("face", v)).toBe(true);
  });

  it.each(FONT_SIZES.map((s) => [s.label, s.css, s.value]))("keeps the %s size (%s, <font size=%s>)", (_l, css, n) => {
    expect(cleanOutgoingCss(`font-size: ${css}`).css).toBe(`font-size: ${css}`);
    expect(fontAttribute("size", n)).toBe(true);
  });

  it.each([...TEXT_COLOURS, ...HIGHLIGHTS].map((c) => [c.label, c.value]))("keeps %s (%s)", (_l, v) => {
    expect(isSafeColor(v)).toBe(true);
    expect(cleanOutgoingCss(`color: ${v}`).css).toBe(`color: ${v}`);
  });

  it.each([...TEXT_COLOURS, ...HIGHLIGHTS].filter((c) => c.value.startsWith("#")).map((c) => asRgb(c.value)))(
    "keeps the browser's form of a palette colour: %s",
    (rgb) => {
      expect(cleanOutgoingCss(`color: ${rgb}; background-color: ${rgb}`).css).toBe(
        `color: ${rgb}; background-color: ${rgb}`,
      );
    },
  );

  it.each(ALIGNMENTS.map((a) => a.value))("keeps text-align: %s", (v) => {
    expect(cleanOutgoingCss(`text-align: ${v}`).css).toBe(`text-align: ${v}`);
  });

  it("uses fixed six-digit colours only, each once", () => {
    for (const list of [TEXT_COLOURS, HIGHLIGHTS]) {
      const values = list.map((c) => c.value);
      expect(new Set(values).size).toBe(values.length);
      expect(values.every((v) => /^#[0-9a-f]{6}$/.test(v) || v === "transparent")).toBe(true);
    }
  });
});

describe("format option helpers", () => {
  it("writes CSS for colour, font, size, alignment, strikethrough and indent only", () => {
    for (const c of ["foreColor", "hiliteColor", "fontName", "fontSize", "justifyCenter", "strikeThrough", "indent"]) {
      expect(writesCss(c)).toBe(true);
    }
    for (const c of ["bold", "italic", "underline", "insertUnorderedList", "createLink", "undo"]) {
      expect(writesCss(c)).toBe(false);
    }
  });

  it("matches the family the browser reports", () => {
    expect(matchFamily("serif")).toBe("serif");
    expect(matchFamily('"Monospace"')).toBe("monospace");
    expect(matchFamily("General Sans, system-ui")).toBeUndefined();
    expect(matchFamily("")).toBeUndefined();
  });

  it("matches the size the browser reports", () => {
    expect(matchSize("5")).toBe("5");
    expect(matchSize(" 3 ")).toBe("3");
    expect(matchSize("4")).toBeUndefined();
  });

  it("turns reported colours into the palette's hex", () => {
    expect(colourHex("rgb(220, 38, 38)")).toBe("#dc2626");
    expect(colourHex("rgba(0, 0, 0, 0)")).toBe("transparent");
    expect(colourHex("rgba(254, 240, 138, 1)")).toBe("#fef08a");
    expect(colourHex("rgb(300, 0, 0)")).toBe("#ff0000");
    expect(colourHex(" #ABC ")).toBe("#abc");
    expect(colourHex(asRgb("#2563eb"))).toBe("#2563eb");
  });

  it("reads the alignment", () => {
    expect(alignmentOf("center")).toBe("center");
    expect(alignmentOf("-webkit-center")).toBe("center");
    expect(alignmentOf("right")).toBe("right");
    expect(alignmentOf("end")).toBe("right");
    expect(alignmentOf("start")).toBe("left");
    expect(alignmentOf("justify")).toBe("left");
  });
});
