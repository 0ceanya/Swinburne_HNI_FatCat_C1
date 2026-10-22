import { invalid } from "./errors.js";

/** SHA-256 of a document's canonical content, as 64 lowercase hex characters. */
export class ContentHash {
  private constructor(readonly hex: string) {}

  static of(hex: string): ContentHash {
    if (!/^[0-9a-f]{64}$/.test(hex)) throw invalid("Not a SHA-256 content hash", "INVALID_HASH");
    return new ContentHash(hex);
  }

  /** 3f9a…c21e, as the screens show it. */
  short(): string {
    return `${this.hex.slice(0, 4)}…${this.hex.slice(-4)}`;
  }

  equals(other: ContentHash | string): boolean {
    return this.hex === (typeof other === "string" ? other : other.hex);
  }

  toString(): string {
    return this.hex;
  }
}
