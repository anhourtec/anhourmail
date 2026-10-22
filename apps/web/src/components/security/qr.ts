// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A small QR code encoder (ISO/IEC 18004, byte mode, every version 1–40, error correction M) for the authenticator
 * set-up code. It runs in the browser from data the page already has: the `otpauth://` link never leaves the page
 * for a QR service (CLAUDE.md rule 29), and no extra dependency is needed.
 *
 * `qrMatrix(text)` returns rows of booleans (true = dark), without the quiet zone; `qrPath` turns it into one SVG path.
 */

/** Error-correction codewords per block, and number of blocks, for level M by version (index 0 unused). */
const ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33,
  35, 37, 38, 40, 43, 45, 47, 49,
];
/** Format bits for level M. */
const ECL_M = 0;

const at = (a: readonly number[], i: number): number => a[i] ?? 0;
const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

/** Data modules in a symbol of this version (everything but function patterns, format and version info). */
function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - at(ECC_PER_BLOCK, ver) * at(BLOCKS, ver);

/** GF(256) multiply with the QR polynomial 0x11D. */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(at(out, j), root) ^ (j + 1 < out.length ? at(out, j + 1) : 0);
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const out = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (out.shift() ?? 0);
    out.push(0);
    divisor.forEach((coef, i) => {
      out[i] = at(out, i) ^ gfMul(coef, factor);
    });
  }
  return out;
}

/** Splits the data into blocks, adds error correction, and interleaves (spec section 7.6). */
function withEcc(data: readonly number[], ver: number): number[] {
  const numBlocks = at(BLOCKS, ver);
  const eccLen = at(ECC_PER_BLOCK, ver);
  const raw = Math.floor(rawModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  const width = blocks[0]?.length ?? 0;
  for (let i = 0; i < width; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(at(block, i));
    });
  }
  return out;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 17 - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class QrSymbol {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  get(x: number, y: number): boolean {
    return this.dark[y]?.[x] ?? false;
  }

  private setFixed(x: number, y: number, dark: boolean): void {
    const row = this.dark[y];
    const f = this.fixed[y];
    if (!row || !f || x < 0 || x >= this.size) return;
    row[x] = dark;
    f[x] = true;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFixed(6, i, i % 2 === 0);
      this.setFixed(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [this.size - 4, 3],
      [3, this.size - 4],
    ] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.setFixed(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = alignmentPositions(this.version);
    const last = pos.length - 1;
    pos.forEach((px, i) => {
      pos.forEach((py, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.setFixed(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      });
    });
    this.drawFormat(0);
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = this.size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.setFixed(a, b, bit(bits, i));
        this.setFixed(b, a, bit(bits, i));
      }
    }
  }

  drawFormat(mask: number): void {
    const data = (ECL_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.setFixed(8, i, bit(bits, i));
    this.setFixed(8, 7, bit(bits, 6));
    this.setFixed(8, 8, bit(bits, 7));
    this.setFixed(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFixed(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.setFixed(this.size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFixed(8, this.size - 15 + i, bit(bits, i));
    this.setFixed(8, this.size - 8, true);
  }

  drawCodewords(data: readonly number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          const row = this.dark[y];
          if (row && !this.fixed[y]?.[x] && i < data.length * 8) {
            row[x] = bit(at(data, i >>> 3), 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    const fn = MASKS[mask];
    if (!fn) return;
    for (let y = 0; y < this.size; y++) {
      const row = this.dark[y];
      if (!row) continue;
      for (let x = 0; x < this.size; x++) if (!this.fixed[y]?.[x] && fn(x, y)) row[x] = !row[x];
    }
  }

  /** Spec penalty rules N1–N4 (adjacent runs, 2×2 blocks, finder-like patterns, dark balance). */
  penalty(): number {
    const n = this.size;
    let score = 0;
    const line = (get: (i: number) => boolean) => {
      let runColor = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      const addHistory = (len: number) => {
        history.pop();
        history.unshift(history[0] === 0 ? len + n : len);
      };
      const finderLike = () => {
        const c = at(history, 1);
        const core =
          c > 0 && at(history, 2) === c && at(history, 3) === c * 3 && at(history, 4) === c && at(history, 5) === c;
        return (
          (core && at(history, 0) >= c * 4 && at(history, 6) >= c ? 1 : 0) +
          (core && at(history, 6) >= c * 4 && at(history, 0) >= c ? 1 : 0)
        );
      };
      for (let i = 0; i < n; i++) {
        if (get(i) === runColor) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else {
          addHistory(run);
          if (!runColor) score += finderLike() * 40;
          runColor = get(i);
          run = 1;
        }
      }
      if (runColor) {
        addHistory(run);
        run = 0;
      }
      addHistory(run + n);
      score += finderLike() * 40;
    };
    for (let y = 0; y < n; y++) line((x) => this.get(x, y));
    for (let x = 0; x < n; x++) line((y) => this.get(x, y));
    let dark = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const c = this.get(x, y);
        if (c) dark++;
        if (
          x < n - 1 &&
          y < n - 1 &&
          c === this.get(x + 1, y) &&
          c === this.get(x, y + 1) &&
          c === this.get(x + 1, y + 1)
        ) {
          score += 3;
        }
      }
    }
    const total = n * n;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/** UTF-8 bytes → data codewords (mode, length, data, terminator, padding) for the smallest version that fits. */
function encodeData(text: string): { version: number; codewords: number[] } {
  const bytes = [...new TextEncoder().encode(text)];
  for (let ver = 1; ver <= 40; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    const capacityBits = dataCodewords(ver) * 8;
    const used = 4 + countBits + bytes.length * 8;
    if (used > capacityBits) continue;
    const bits: number[] = [];
    const push = (value: number, len: number) => {
      for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    push(0b0100, 4);
    push(bytes.length, countBits);
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, capacityBits - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
    const codewords: number[] = [];
    for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    return { version: ver, codewords };
  }
  throw new RangeError("Text too long for a QR code");
}

export function qrMatrix(text: string): boolean[][] {
  const { version, codewords } = encodeData(text);
  const s = new QrSymbol(version);
  s.drawFunctionPatterns();
  s.drawCodewords(withEcc(codewords, version));
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    s.applyMask(mask);
    s.drawFormat(mask);
    const score = s.penalty();
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    s.applyMask(mask);
  }
  s.applyMask(best);
  s.drawFormat(best);
  return s.dark.map((row) => [...row]);
}

/** One SVG path (unit squares) for the dark modules, offset by a quiet zone of `border` modules. */
export function qrPath(matrix: readonly (readonly boolean[])[], border = 4): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${String(x + border)} ${String(y + border)}h1v1h-1z`);
    });
  });
  return parts.join("");
}
