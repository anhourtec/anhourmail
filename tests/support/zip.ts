// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Test support: reads a ZIP back through its central directory, as unzip tools do, and checks each entry's size and
 * CRC (zip writer unit tests, the data export integration tests). Deflated entries only.
 */
import { crc32, inflateRawSync } from "node:zlib";

/** Reads an archive back through its central directory (as unzip tools do) and checks every CRC. */
export function readZip(buf: Buffer): { name: string; data: Buffer; modified: { time: number; date: number } }[] {
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
