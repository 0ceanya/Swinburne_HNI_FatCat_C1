/**
 * Tide's "TideMemory" container format, reimplemented so the server needs no browser SDK.
 *
 *   [int32 LE version = 1] then, per entry, [int32 LE length][bytes]
 *
 * Byte-compatible with `Tools.TideMemory` in @tideorg/js (cross-checked in test/tide/codec.test.ts).
 * One quirk is preserved on purpose: an EMPTY array encodes to zero bytes, not a bare version header.
 */

export function container(entries: Uint8Array[]): Uint8Array {
  if (entries.length === 0) return new Uint8Array(0);
  const total = 4 + entries.reduce((n, e) => n + 4 + e.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setInt32(0, 1, true);
  let at = 4;
  for (const entry of entries) {
    view.setInt32(at, entry.length, true);
    at += 4;
    out.set(entry, at);
    at += entry.length;
  }
  return out;
}

/** Entry `index` of a container. Throws if the buffer is too short. */
export function getValue(buf: Uint8Array, index: number): Uint8Array {
  if (buf.length < 4) throw new RangeError("TideMemory: buffer has no header");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 4;
  for (let i = 0; i < index; i++) {
    if (at + 4 > buf.length) throw new RangeError(`TideMemory: index ${index} out of range`);
    at += 4 + view.getInt32(at, true);
  }
  if (at + 4 > buf.length) throw new RangeError(`TideMemory: index ${index} out of range`);
  const length = view.getInt32(at, true);
  at += 4;
  if (length < 0 || at + length > buf.length) throw new RangeError(`TideMemory: entry ${index} overruns buffer`);
  return buf.subarray(at, at + length);
}

export function tryGetValue(buf: Uint8Array, index: number): Uint8Array | undefined {
  try {
    return getValue(buf, index);
  } catch {
    return undefined;
  }
}

/** Every entry of a container, in order. Empty for a zero-length buffer. */
export function entries(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; ; i++) {
    const v = tryGetValue(buf, i);
    if (v === undefined) return out;
    out.push(v);
  }
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

export function int32LE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
