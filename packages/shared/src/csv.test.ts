// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { csvCell, decodeCsvBytes, detectDelimiter, looksLikeFormula, parseCsv, parseCsvText, toCsv } from "./csv";

const utf8 = (s: string) => new TextEncoder().encode(s);
const table = (text: string) => {
  const r = parseCsvText(text);
  if (!r.ok) throw new Error(r.error);
  return r.table;
};

describe("parseCsvText", () => {
  it("reads a header and rows, trimming header names only", () => {
    expect(table(" Name , E-mail \nAda, ada@example.org \n")).toEqual({
      delimiter: ",",
      header: ["Name", "E-mail"],
      rows: [["Ada", " ada@example.org "]],
    });
  });

  it("handles quoted fields with delimiters, escaped quotes and embedded newlines", () => {
    const t = table('Name,Notes\n"Lovelace, Ada","said ""hello""\nand left"\n"",x\n');
    expect(t.rows).toEqual([
      ["Lovelace, Ada", 'said "hello"\nand left'],
      ["", "x"],
    ]);
  });

  it("accepts CRLF, LF and lone CR line ends and skips blank lines", () => {
    expect(table("a,b\r\n1,2\r\n\r\n3,4\r5,6").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
    // A CRLF inside quotes stays in the value.
    expect(table('a\r\n"x\r\ny"\r\n').rows).toEqual([["x\r\ny"]]);
  });

  it("detects semicolon and tab delimiters from the header line, ignoring quoted ones", () => {
    expect(table("Name;E-mail\nAda;ada@example.org").delimiter).toBe(";");
    expect(table("Name\tE-mail\nAda\tada@example.org").rows).toEqual([["Ada", "ada@example.org"]]);
    expect(detectDelimiter('"a,b,c";d;e\n1,2,3,4')).toBe(";");
    expect(detectDelimiter("single")).toBe(",");
    expect(detectDelimiter("a;b,c")).toBe(",");
  });

  it("keeps formula-like values as plain text, never evaluated or altered", () => {
    expect(table('Name,Phone,Notes\n=HYPERLINK("x"),+1 555 0100,@SUM(A1)\n-2,\'=x,\t=y').rows).toEqual([
      ['=HYPERLINK("x")', "+1 555 0100", "@SUM(A1)"],
      ["-2", "'=x", "\t=y"],
    ]);
  });

  it("is lenient about a stray quote inside an unquoted cell or after a quoted part", () => {
    expect(table('a,b\nsay "hi",x\n"q"z,y').rows).toEqual([
      ['say "hi"', "x"],
      ["qz", "y"],
    ]);
  });

  it("refuses an unterminated quote, an empty file and the limits", () => {
    expect(parseCsvText('a,b\n"open,1\n')).toEqual({ ok: false, error: "unterminated_quote" });
    expect(parseCsvText("")).toEqual({ ok: false, error: "empty" });
    expect(parseCsvText("\n\r\n")).toEqual({ ok: false, error: "empty" });
    expect(parseCsvText("h\n1\n2\n3", { maxRows: 2 })).toEqual({ ok: false, error: "too_many_rows" });
    expect(parseCsvText("h\n1\n2", { maxRows: 2 }).ok).toBe(true);
    expect(parseCsvText("a,b,c", { maxColumns: 2 })).toEqual({ ok: false, error: "too_many_columns" });
    expect(parseCsvText("h\nabcdef", { maxCellLength: 5 })).toEqual({ ok: false, error: "cell_too_long" });
    expect(parseCsvText('h\n"abcdef"', { maxCellLength: 5 })).toEqual({ ok: false, error: "cell_too_long" });
  });
});

describe("parseCsv (bytes)", () => {
  it("reads UTF-8 with and without a BOM", () => {
    const plain = parseCsv(utf8("Name\nRenée\n"));
    const bom = parseCsv(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("Name\nRenée\n")]));
    for (const r of [plain, bom])
      expect(r).toEqual({ ok: true, table: { delimiter: ",", header: ["Name"], rows: [["Renée"]] } });
  });

  it("reads UTF-16 LE and BE with a BOM", () => {
    const text = "Name;E-mail\r\nZoë;zoe@example.org\r\n";
    const le = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from(text, "utf16le"))]);
    const beBody = Buffer.from(text, "utf16le").swap16();
    const be = new Uint8Array([0xfe, 0xff, ...new Uint8Array(beBody)]);
    for (const bytes of [le, be]) {
      const r = parseCsv(bytes);
      expect(r).toEqual({
        ok: true,
        table: { delimiter: ";", header: ["Name", "E-mail"], rows: [["Zoë", "zoe@example.org"]] },
      });
    }
  });

  it("refuses other encodings and files over the size limit", () => {
    // "Renée" in Windows-1252: 0xE9 is not valid UTF-8.
    expect(parseCsv(new Uint8Array([...utf8("Name\nRen"), 0xe9, ...utf8("e\n")]))).toEqual({
      ok: false,
      error: "encoding",
    });
    expect(decodeCsvBytes(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(parseCsv(utf8("a,b\n1,2"), { maxBytes: 4 })).toEqual({ ok: false, error: "too_large" });
  });
});

describe("csv writing", () => {
  it("puts a quote mark before anything a spreadsheet would run", () => {
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1"]) expect(looksLikeFormula(v)).toBe(true);
    for (const v of ["", "a=1", "1-2", "mail@example.org", " =1"]) expect(looksLikeFormula(v)).toBe(false);
    expect(csvCell("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe('"\'\t=1"');
  });

  it("quotes cells with delimiters, quotes and line breaks, and ends lines with CRLF", () => {
    expect(
      toCsv([
        ["mailbox", "error"],
        ["a@example.org", 'said "no", twice\nreally'],
        ["b;c", ""],
      ]),
    ).toBe('mailbox,error\r\na@example.org,"said ""no"", twice\nreally"\r\n"b;c",\r\n');
  });

  it("round-trips through the reader (escaped formulas stay escaped)", () => {
    const rows = [
      ["h1", "h2"],
      ["=x", 'a "b", c\nd'],
    ];
    const r = parseCsvText(toCsv(rows));
    expect(r).toEqual({ ok: true, table: { delimiter: ",", header: ["h1", "h2"], rows: [["'=x", 'a "b", c\nd']] } });
  });
});
