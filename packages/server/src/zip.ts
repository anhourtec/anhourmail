// SPDX-License-Identifier: MIT
import { constants, crc32, createDeflateRaw, type DeflateRaw } from "node:zlib";

/**
 * A small streaming ZIP writer (PKWARE APPNOTE 6.3): deflated entries with data descriptors, UTF-8 names, ZIP64 end
 * records when the archive passes 4 GiB or 65,535 entries. Each entry must stay below 4 GiB (callers split long files
 * into parts). Output goes to `emit` as it is produced, so a large archive never sits in memory; `emit` is awaited,
 * which is the back-pressure.
 *
 * Used for data exports (ADR-0025): the worker's control-plane archive (`zipFiles`) and the webmail's mail export.
 */

const U32 = 0xffff_ffff;
const U16 = 0xffff;
const VERSION_DEFLATE = 20;
const VERSION_ZIP64 = 45;
/** Bit 3: sizes and CRC follow the data (data descriptor). Bit 11: the name is UTF-8. */
const FLAGS = 0x0808;
const METHOD_DEFLATE = 8;

export class ZipError extends Error {
  override readonly name = "ZipError";
}

type Written = {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  time: number;
  date: number;
};

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export class ZipWriter {
  readonly #emit: (chunk: Uint8Array) => Promise<void>;
  readonly #entries: Written[] = [];
  #offset = 0;
  #current: (Written & { deflate: DeflateRaw; out: Buffer[] }) | null = null;
  #finished = false;

  constructor(emit: (chunk: Uint8Array) => Promise<void>) {
    this.#emit = emit;
  }

  async #push(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return;
    this.#offset += chunk.byteLength;
    await this.#emit(chunk);
  }

  /** Bytes written to the current entry so far (uncompressed); 0 when none is open. */
  get entrySize(): number {
    return this.#current?.size ?? 0;
  }

  /** Starts an entry. `name` uses `/` between folders; it must be unique in the archive (the caller's job). */
  async begin(name: string, modified: Date = new Date()): Promise<void> {
    if (this.#finished) throw new ZipError("The archive is finished");
    if (this.#current) await this.end();
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.length === 0 || nameBytes.length > U16) throw new ZipError("Bad entry name");
    if (this.#entries.length >= 1_000_000) throw new ZipError("Too many entries");
    const { time, date } = dosTime(modified);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION_DEFLATE, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(METHOD_DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // CRC and sizes are zero here: they follow the data in the descriptor.
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    const offset = this.#offset;
    await this.#push(Buffer.concat([header, nameBytes]));
    const out: Buffer[] = [];
    const deflate = createDeflateRaw({ level: 6 });
    deflate.on("data", (c: Buffer) => out.push(c));
    this.#current = { name: nameBytes, crc: 0, compressed: 0, size: 0, offset, time, date, deflate, out };
  }

  async #drain(): Promise<void> {
    const c = this.#current;
    if (!c) return;
    const chunks = c.out.splice(0);
    for (const chunk of chunks) {
      c.compressed += chunk.length;
      await this.#push(chunk);
    }
  }

  /** Adds bytes to the current entry and pushes what has been compressed so far. */
  async write(data: Uint8Array | string): Promise<void> {
    const c = this.#current;
    if (!c) throw new ZipError("No entry is open");
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    if (c.size + bytes.byteLength >= U32) throw new ZipError("Entry too large; split it into parts");
    c.crc = crc32(bytes, c.crc);
    c.size += bytes.byteLength;
    await new Promise<void>((resolve, reject) => {
      c.deflate.write(bytes, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    // A sync flush now and then keeps memory bounded without hurting compression much.
    if (c.out.length > 0) await this.#drain();
  }

  /** Pushes everything written so far (a sync flush), e.g. after each message of an mbox file. */
  async flush(): Promise<void> {
    const c = this.#current;
    if (!c) return;
    await new Promise<void>((resolve) => {
      c.deflate.flush(constants.Z_SYNC_FLUSH, () => {
        resolve();
      });
    });
    await this.#drain();
  }

  /** Ends the current entry: the rest of the compressed data, then its descriptor. */
  async end(): Promise<void> {
    const c = this.#current;
    if (!c) return;
    await new Promise<void>((resolve, reject) => {
      c.deflate.once("end", resolve);
      c.deflate.once("error", reject);
      c.deflate.end();
    });
    await this.#drain();
    if (c.compressed >= U32) throw new ZipError("Entry too large; split it into parts");
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(c.crc >>> 0, 4);
    descriptor.writeUInt32LE(c.compressed, 8);
    descriptor.writeUInt32LE(c.size, 12);
    await this.#push(descriptor);
    const { deflate: _deflate, out: _out, ...written } = c;
    this.#entries.push(written);
    this.#current = null;
  }

  /** Writes the central directory and the end records. The writer can't be used afterwards. */
  async finish(): Promise<void> {
    if (this.#current) await this.end();
    if (this.#finished) return;
    this.#finished = true;
    const cdStart = this.#offset;
    for (const e of this.#entries) {
      const zip64 = e.offset >= U32;
      const extra = zip64 ? Buffer.concat([Buffer.from([0x01, 0x00, 0x08, 0x00]), u64(e.offset)]) : Buffer.alloc(0);
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | VERSION_ZIP64, 4); // made by: Unix
      h.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION_DEFLATE, 6);
      h.writeUInt16LE(FLAGS, 8);
      h.writeUInt16LE(METHOD_DEFLATE, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc >>> 0, 16);
      h.writeUInt32LE(e.compressed, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attributes
      h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
      h.writeUInt32LE(zip64 ? U32 : e.offset, 42);
      await this.#push(Buffer.concat([h, e.name, extra]));
    }
    const cdSize = this.#offset - cdStart;
    const count = this.#entries.length;
    const needs64 = count >= U16 || cdStart >= U32 || cdSize >= U32;
    if (needs64) {
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE((3 << 8) | VERSION_ZIP64, 12);
      record.writeUInt16LE(VERSION_ZIP64, 14);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(cdSize), 40);
      record.writeBigUInt64LE(BigInt(cdStart), 48);
      const recordAt = this.#offset;
      await this.#push(record);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(recordAt), 8);
      locator.writeUInt32LE(1, 16);
      await this.#push(locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, U16), 8);
    end.writeUInt16LE(Math.min(count, U16), 10);
    end.writeUInt32LE(Math.min(cdSize, U32), 12);
    end.writeUInt32LE(Math.min(cdStart, U32), 16);
    await this.#push(end);
  }
}

/** A whole small archive in memory (e.g. the control-plane export). */
export async function zipFiles(files: readonly { name: string; data: Uint8Array | string }[], modified = new Date()) {
  const chunks: Uint8Array[] = [];
  const zip = new ZipWriter(async (c) => {
    chunks.push(c);
  });
  for (const f of files) {
    await zip.begin(f.name, modified);
    await zip.write(f.data);
    await zip.end();
  }
  await zip.finish();
  return Buffer.concat(chunks);
}

/**
 * A safe archive path segment from a name people chose (a folder): no separators, control characters, leading dots or
 * reserved characters; at most 100 characters; never empty.
 */
export function zipSegment(name: string, fallback = "untitled"): string {
  const cleaned = Array.from(name.normalize("NFC"))
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || '/\\:*?"<>|'.includes(ch) ? "_" : ch;
    })
    .join("")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 100);
  return cleaned === "" ? fallback : cleaned;
}
