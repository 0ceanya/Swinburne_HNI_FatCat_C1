import { describe, expect, it } from "vitest";
import { fileSecret, parseFileSecret, quorumText, shortHash, timeAgo } from "./format";

describe("quorum wording", () => {
  it("says how many board members a level needs, capped at the board size", () => {
    expect(quorumText(1, 3)).toBe("1 person (the requester alone, logged)");
    expect(quorumText(2, 3)).toBe("2 of 3 board members");
    expect(quorumText(3, 3)).toBe("3 of 3 board members");
    expect(quorumText(4, 3)).toBe("3 of 3 board members: level 4 is capped at the board size");
    expect(quorumText(4, 5)).toBe("4 of 5 board members");
  });
});

describe("file secrets", () => {
  it("round-trips a file through the text that Tide encrypts", () => {
    const s = fileSecret("chu ky so.p12", "application/x-pkcs12", "AAEC");
    expect(parseFileSecret(s)).toEqual({ name: "chu ky so.p12", mime: "application/x-pkcs12", base64: "AAEC" });
  });

  it("leaves ordinary secrets alone", () => {
    expect(parseFileSecret("sk_live_123")).toBeNull();
    expect(parseFileSecret("data:text/plain,hello")).toBeNull();
  });
});

describe("formatting", () => {
  it("shortens hashes to first 4 + last 4", () => {
    expect(shortHash("3f9a" + "0".repeat(56) + "c21e")).toBe("3f9a…c21e");
    expect(shortHash(null)).toBe("—");
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-10-22T10:00:00Z");
    expect(timeAgo("2026-10-22T09:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-10-22T09:30:00Z", now)).toBe("30 min ago");
    expect(timeAgo("2026-10-20T10:00:00Z", now)).toBe("2 d ago");
  });
});
