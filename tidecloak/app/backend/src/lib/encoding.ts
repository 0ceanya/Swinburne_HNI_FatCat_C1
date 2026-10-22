import { createHash } from "node:crypto";

export const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

/** Strict standard base64 (no URL alphabet, correct padding); throws on anything else. */
export function fromBase64(s: string): Uint8Array {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
    throw new TypeError("not base64");
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

export const base64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export const fromBase64url = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/**
 * Canonical JSON: object keys sorted, no whitespace, bigint written as a decimal string.
 * Hash inputs always go through this so the same content always hashes the same.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
