// SPDX-License-Identifier: MIT
import { randomBytes } from "node:crypto";

import { crc32, inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { ZipError, zipFiles, zipSegment, ZipWriter } from "./zip";

/** Reads an archive back through its central directory (as unzip tools do) and checks every CRC. */
function readZip(buf: Buffer): { name: string; data: Buffer; modified: { time: number; date: number } }[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no end record");
  let count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  if (cd === 0xffff_ffff || count === 0xffff) {
    const locator = eocd - 20;
    const record = Number(buf.readBigUInt64LE(locator + 8));
    count = Number(buf.readBigUInt64LE(record + 32));
    cd = Number(buf.readBigUInt64LE(record + 48));
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("bad central header");
    const crc = buf.readUInt32LE(cd + 16);
    const compressed = buf.readUInt32LE(cd + 20);
    const size = buf.readUInt32LE(cd + 24);
    const nameLength = buf.readUInt16LE(cd + 28);
    const extraLength = buf.readUInt16LE(cd + 30);
    let offset = buf.readUInt32LE(cd + 42);
    const name = buf.subarray(cd + 46, cd + 46 + nameLength).toString("utf8");
    if (offset === 0xffff_ffff) offset = Number(buf.readBigUInt64LE(cd + 46 + nameLength + 4));
    if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error("bad local header");
    const localName = buf.readUInt16LE(offset + 26);
    const localExtra = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const data = inflateRawSync(buf.subarray(start, start + compressed));
    if (data.length !== size) throw new Error(`size mismatch for ${name}`);
    if (crc32(data) >>> 0 !== crc) throw new Error(`CRC mismatch for ${name}`);
    out.push({ name, data, modified: { time: buf.readUInt16LE(cd + 12), date: buf.readUInt16LE(cd + 14) } });
    cd += 46 + nameLength + extraLength;
  }
  return out;
}

describe("zip writer", () => {
  it("writes entries a central-directory reader opens, with UTF-8 names and the given time", async () => {
    const big = randomBytes(300_000);
    const zip = await zipFiles(
      [
        { name: "README.txt", data: "hello\n" },
        { name: "Dossier élève/notes.json", data: JSON.stringify({ a: 1 }) },
        { name: "random.bin", data: big },
        { name: "empty.txt", data: "" },
      ],
      new Date("2026-10-29T13:14:16Z"),
    );
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["README.txt", "Dossier élève/notes.json", "random.bin", "empty.txt"]);
    expect(entries[0]?.data.toString("utf8")).toBe("hello\n");
    expect(entries[2]?.data.equals(big)).toBe(true);
    expect(entries[3]?.data.length).toBe(0);
    // DOS time: 13:14:16 and 2026-10-29.
    expect(entries[0]?.modified).toEqual({ time: (13 << 11) | (14 << 5) | 8, date: (46 << 9) | (10 << 5) | 29 });
  });

  it("streams: many writes and flushes in one entry, output emitted as it goes", async () => {
    const parts: Uint8Array[] = [];
    let emitted = 0;
    const zip = new ZipWriter(async (c) => {
      parts.push(c);
      emitted += c.byteLength;
    });
    await zip.begin("mail/Inbox.mbox");
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      const line = `From MAILER-DAEMON Thu Oct 29 12:00:00 2026\nSubject: ${String(i)}\n\n${randomBytes(500).toString("base64")}\n\n`;
      lines.push(line);
      await zip.write(line);
      await zip.flush();
    }
    expect(zip.entrySize).toBe(lines.join("").length);
    expect(emitted).toBeGreaterThan(1000);
    await zip.finish();
    const [entry] = readZip(Buffer.concat(parts));
    expect(entry?.data.toString("utf8")).toBe(lines.join(""));
  });

  it("refuses misuse", async () => {
    const zip = new ZipWriter(async () => undefined);
    await expect(zip.write("x")).rejects.toThrow(ZipError);
    await expect(zip.begin("")).rejects.toThrow(/Bad entry name/);
    await zip.finish();
    await expect(zip.begin("late.txt")).rejects.toThrow(/finished/);
  });

  it("makes safe path segments from people's folder names", () => {
    expect(zipSegment("Inbox")).toBe("Inbox");
    expect(zipSegment("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(zipSegment('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(zipSegment("\u0000\u001f")).toBe("__");
    expect(zipSegment("...")).toBe("untitled");
    expect(zipSegment("   ", "folder")).toBe("folder");
    expect(zipSegment("x".repeat(300))).toHaveLength(100);
  });
});
