import { invalid } from "./errors.js";

/** An amount of Vietnamese đồng. Whole đồng only, never a float. */
export class Money {
  private constructor(readonly dong: bigint) {}

  static readonly MAX = 10n ** 15n; // one quadrillion đồng: far above any SME document

  static ofDong(value: bigint | number | string): Money {
    let dong: bigint;
    if (typeof value === "bigint") dong = value;
    else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw invalid("Amount must be a whole number of đồng", "INVALID_AMOUNT");
      dong = BigInt(value);
    } else {
      // Digits only: no sign, separator, decimal point or whitespace, so no locale can change the value.
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw invalid("Amount must be digits only, e.g. 640000000", "INVALID_AMOUNT");
      dong = BigInt(value);
    }
    if (dong < 0n) throw invalid("Amount cannot be negative", "INVALID_AMOUNT");
    if (dong > Money.MAX) throw invalid("Amount is too large", "INVALID_AMOUNT");
    return new Money(dong);
  }

  toString(): string {
    return this.dong.toString();
  }

  /** Vietnamese grouping: 640.000.000 ₫ */
  format(): string {
    return `${this.dong.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ₫`;
  }

  equals(other: Money): boolean {
    return this.dong === other.dong;
  }
}
