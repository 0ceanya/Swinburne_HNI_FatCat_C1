import { describe, expect, it } from "vitest";
import type { Policy } from "@/api/types";
import { compactVnd, formatVnd, parseVndInput, shortHash } from "./format";
import { describeRange, describeRequirement, ruleFor } from "./policy";

describe("money formatting", () => {
  it("formats VND with Vietnamese grouping and keeps big amounts exact", () => {
    expect(formatVnd("640000000")).toBe("640.000.000 ₫");
    expect(formatVnd("0")).toBe("0 ₫");
    expect(formatVnd("123456789012345678")).toBe("123.456.789.012.345.678 ₫");
    expect(formatVnd("12.5")).toBe("—");
  });

  it("parses what people type into canonical digits", () => {
    expect(parseVndInput("640.000.000")).toBe("640000000");
    expect(parseVndInput("640 000 000 ₫")).toBe("640000000");
    expect(parseVndInput("007")).toBe("7");
    expect(parseVndInput("1,5")).toBe("15");
    expect(parseVndInput("abc")).toBeNull();
    expect(parseVndInput("-5")).toBeNull();
    expect(parseVndInput("")).toBeNull();
  });

  it("compacts for tight spaces", () => {
    expect(compactVnd("640000000")).toMatch(/640 tr ₫/);
    expect(compactVnd("2100000000")).toMatch(/2,1 tỷ ₫/);
  });

  it("shortens hashes to first 4 + last 4", () => {
    expect(shortHash("3f9a" + "0".repeat(56) + "c21e")).toBe("3f9a…c21e");
    expect(shortHash(null)).toBe("—");
  });
});

const policy: Policy = {
  version: 1, status: "active", reason: "", proposedBy: { id: "s", name: "s" }, proposedAt: "", endorsements: [], activatedAt: "",
  rules: [
    { id: "low", label: "low", documentTypes: ["payment_voucher", "e_invoice"], minDong: "0", maxDong: "19999999", requiredTiers: [{ tier: "drafter", count: 1 }], initiatorMayApprove: true, network: { role: "sg_drafter", threshold: 1 }, networkSigned: true },
    { id: "mid", label: "mid", documentTypes: ["payment_voucher", "e_invoice"], minDong: "20000000", maxDong: "500000000", requiredTiers: [{ tier: "director", count: 1 }], initiatorMayApprove: false, network: { role: "sg_director", threshold: 1 }, networkSigned: true },
    { id: "high", label: "high", documentTypes: ["payment_voucher", "e_invoice"], minDong: "500000001", maxDong: null, requiredTiers: [{ tier: "director", count: 1 }, { tier: "owner", count: 1 }], initiatorMayApprove: false, network: { role: "sg_director", threshold: 2 }, networkSigned: true },
  ],
};

describe("rule preview (mirrors the server's bands)", () => {
  it.each([["19999999", "low"], ["20000000", "mid"], ["500000000", "mid"], ["500000001", "high"], ["900000000000", "high"]])("%s ₫ → %s", (amount, id) => {
    expect(ruleFor(policy, "payment_voucher", amount)?.id).toBe(id);
  });

  it("returns nothing for an empty or invalid amount", () => {
    expect(ruleFor(policy, "payment_voucher", null)).toBeNull();
    expect(ruleFor(policy, "payment_voucher", "1.5")).toBeNull();
  });

  it("describes requirements and ranges in plain words", () => {
    expect(describeRequirement(policy.rules[0]!)).toBe("You sign alone (logged)");
    expect(describeRequirement(policy.rules[2]!)).toBe("Needs approval from: director + owner");
    expect(describeRange(policy.rules[0]!, formatVnd)).toBe("Below 20.000.000 ₫");
    expect(describeRange(policy.rules[2]!, formatVnd)).toBe("500.000.001 ₫ and above");
  });
});
