import { equalBytes, getValue } from "../lib/tideMemory.js";
import type { DraftEntry } from "./requestInspector.js";

/**
 * The network's ciphertext for one value: @tideorg/js `PolicyProtectedSerializedField` version 2,
 *
 *   [version (1 byte = 2), encFieldChk, timestamp (8 bytes), encKey, signature]
 *
 * For a value under 32 bytes, encFieldChk is the ElGamal ciphertext itself and encKey is empty. For
 * a larger value, encFieldChk is AES output and encKey is the ElGamal ciphertext of its data key.
 * Either way the first 32 bytes of the ElGamal part are the C1 point the network works on.
 * Cross-checked against the SDK in test/tide/vaultCodec.test.ts.
 */
export const SEALED_FIELD_VERSION = 2;

export interface SealedField {
  c1: Uint8Array;
  timestamp: Uint8Array;
  signature: Uint8Array;
}

export class SealedFieldError extends Error {}

export function parseSealedField(bytes: Uint8Array): SealedField {
  try {
    const version = getValue(bytes, 0);
    if (version.length !== 1 || version[0] !== SEALED_FIELD_VERSION) throw new SealedFieldError(`unsupported sealed-field version`);
    const encFieldChk = getValue(bytes, 1);
    const timestamp = getValue(bytes, 2);
    const encKey = getValue(bytes, 3);
    const signature = getValue(bytes, 4);
    const elgamal = encKey.length > 0 ? encKey : encFieldChk;
    if (elgamal.length < 32) throw new SealedFieldError("ciphertext is too short");
    if (timestamp.length !== 8) throw new SealedFieldError("timestamp must be 8 bytes");
    return { c1: elgamal.subarray(0, 32), timestamp, signature };
  } catch (e) {
    if (e instanceof SealedFieldError) throw e;
    throw new SealedFieldError(`not a Tide sealed field: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The draft refers to exactly this ciphertext (same value, same time and, for a release, the network's signature). */
export function draftMatchesField(entry: DraftEntry, field: SealedField, opts: { checkSignature: boolean }): boolean {
  return equalBytes(entry.c1, field.c1) && equalBytes(entry.timestamp, field.timestamp)
    && (!opts.checkSignature || equalBytes(entry.signature, field.signature));
}
