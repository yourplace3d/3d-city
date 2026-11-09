/**
 * Reading a ZIP archive the user picked, one file at a time and in pieces: a city's timetable
 * unpacks to a few hundred MB, too much to hold at once on a phone. Only the archive's directory
 * (at its end) is read up front; each file's bytes are sliced out of the archive and unpacked as a
 * stream with the browser's own `DecompressionStream`. ZIP64 archives (over 4 GB, or made by tools
 * that always write ZIP64) are read too. Works on any Blob, so tests can run it in Node.
 */

export interface ZipItem {
  /** the full name in the archive, e.g. "gtfs/stops.txt" */
  name: string;
  /** 0 stored, 8 deflated */
  method: number;
  packed: number;
  size: number;
  /** where the item's local header starts */
  offset: number;
}

export type ZipProblemKind = 'notZip' | 'method' | 'unpack';

export class ZipProblem extends Error {
  constructor(readonly kind: ZipProblemKind, message = kind) {
    super(message);
    this.name = 'ZipProblem';
  }
}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;

async function bytes(blob: Blob, start: number, end: number): Promise<DataView> {
  const buf = await blob.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

const u64 = (v: DataView, at: number) => v.getUint32(at, true) + v.getUint32(at + 4, true) * 2 ** 32;

/** The items in an archive, from its central directory. */
export async function listZip(blob: Blob): Promise<ZipItem[]> {
  // the end record is in the last 22 bytes, plus a comment of up to 64 KB
  const tailStart = Math.max(0, blob.size - 22 - 0xffff);
  const tail = await bytes(blob, tailStart, blob.size);
  let at = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new ZipProblem('notZip');
  let count = tail.getUint16(at + 10, true);
  let dirSize = tail.getUint32(at + 12, true);
  let dirStart = tail.getUint32(at + 16, true);
  if (dirStart === MAX32 || dirSize === MAX32 || count === 0xffff) {
    // ZIP64: a locator just before the end record points at the ZIP64 end record
    const loc = at - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== EOCD64_LOCATOR) throw new ZipProblem('notZip');
    const end64 = u64(tail, loc + 8);
    const rec = await bytes(blob, end64, end64 + 56);
    if (rec.getUint32(0, true) !== EOCD64) throw new ZipProblem('notZip');
    count = u64(rec, 32);
    dirSize = u64(rec, 40);
    dirStart = u64(rec, 48);
  }
  if (dirStart + dirSize > blob.size) throw new ZipProblem('notZip');
  const dir = await bytes(blob, dirStart, dirStart + dirSize);
  const dec = new TextDecoder();
  const items: ZipItem[] = [];
  let p = 0;
  for (let k = 0; k < count && p + 46 <= dir.byteLength; k++) {
    if (dir.getUint32(p, true) !== CENTRAL) throw new ZipProblem('notZip');
    const method = dir.getUint16(p + 10, true);
    let packed = dir.getUint32(p + 20, true);
    let size = dir.getUint32(p + 24, true);
    const nameLen = dir.getUint16(p + 28, true);
    const extraLen = dir.getUint16(p + 30, true);
    const commentLen = dir.getUint16(p + 32, true);
    let offset = dir.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen));
    // ZIP64 sizes and offset, in that order, for each that didn't fit in 32 bits
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = dir.getUint16(x, true);
      const len = dir.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === MAX32) (size = u64(dir, q)), (q += 8);
        if (packed === MAX32) (packed = u64(dir, q)), (q += 8);
        if (offset === MAX32) offset = u64(dir, q);
      }
      x += 4 + len;
    }
    items.push({ name, method, packed, size, offset });
    p = xEnd + commentLen;
  }
  return items;
}

/** An item's unpacked bytes, as a stream. */
export async function openItem(blob: Blob, item: ZipItem): Promise<ReadableStream<Uint8Array>> {
  const head = await bytes(blob, item.offset, item.offset + 30);
  if (head.getUint32(0, true) !== LOCAL) throw new ZipProblem('notZip');
  const start = item.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const raw = blob.slice(start, start + item.packed).stream() as ReadableStream<Uint8Array>;
  if (item.method === 0) return raw;
  if (item.method !== 8) throw new ZipProblem('method');
  let inflate: DecompressionStream;
  try {
    inflate = new DecompressionStream('deflate-raw');
  } catch {
    // older browsers (Safari before 16.4) can't unpack ZIP files themselves
    throw new ZipProblem('unpack');
  }
  return raw.pipeThrough(inflate as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/** The item with this file name, in any folder of the archive (case ignored), or null. */
export function findItem(items: ZipItem[], fileName: string): ZipItem | null {
  const want = fileName.toLowerCase();
  let best: ZipItem | null = null;
  for (const it of items) {
    const base = it.name.slice(it.name.lastIndexOf('/') + 1).toLowerCase();
    if (base !== want || it.name.startsWith('__MACOSX/')) continue;
    // the one nearest the top, if a folder holds a second copy
    if (!best || it.name.split('/').length < best.name.split('/').length) best = it;
  }
  return best;
}
