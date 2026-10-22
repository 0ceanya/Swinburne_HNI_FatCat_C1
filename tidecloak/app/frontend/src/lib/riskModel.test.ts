import { describe, expect, it } from "vitest";
import type { AuditRow } from "@/api/types";
import { makeKey } from "@/test/fixtures";
import { buildInsights, seededRandom } from "./riskModel";

const NOW = new Date("2026-10-22T10:00:00Z");
const row = (seq: number, event: string, at: string, over: Partial<AuditRow> = {}): AuditRow => ({
  seq, at, event, actor: { id: "u-acct", name: "Trần Thị Bình" }, keyId: "key_1", requestId: "req_1", details: {}, prevHash: "", hash: "", ...over,
});

describe("simulated risk model", () => {
  it("gives the same numbers all day, so a recording does not change on reload", () => {
    const a = buildInsights({ keys: [makeKey()], audit: [], now: NOW });
    const b = buildInsights({ keys: [makeKey()], audit: [], now: new Date("2026-10-22T18:00:00Z") });
    expect(a).toEqual(b);
    expect(seededRandom("x")()).toBe(seededRandom("x")());
  });

  it("counts real activity per day, and turns a refused self-approval into a critical alert", () => {
    // Local times (no Z): business hours are judged in the viewer's own timezone.
    const audit = [
      row(1, "key.registered", "2026-10-21T09:00:00"),
      row(2, "request.denied_attempt", "2026-10-21T10:00:00", { details: { code: "REQUESTER_APPROVES_AT_FINISH" } }),
      row(3, "release.completed", "2026-10-22T11:00:00"),
    ];
    const out = buildInsights({ keys: [makeKey()], audit, now: NOW, simulate: false });
    expect(out.days).toHaveLength(14);
    expect(out.totals).toMatchObject({ added: 1, refused: 1, unlocks: 1, keysInVault: 1 });
    expect(out.alerts).toHaveLength(1);
    expect(out.alerts[0]).toMatchObject({ severity: "critical", title: "Tried to approve their own request", keyName: "AWS root", simulated: false });
    expect(out.activity.find((r) => r.seq === 2)?.verdict).toBe("unusual");
    expect(out.activity.find((r) => r.seq === 3)?.verdict).toBe("normal");
  });

  it("flags an unlock in the middle of the night", () => {
    const out = buildInsights({ keys: [makeKey()], audit: [row(1, "release.completed", "2026-10-22T02:14:00")], now: NOW, simulate: false });
    expect(out.alerts).toEqual([expect.objectContaining({ severity: "high", title: "Unlocked outside business hours" })]);
  });

  it("with simulation off, nothing is invented", () => {
    const out = buildInsights({ keys: [], audit: [], now: NOW, simulate: false });
    expect(out.totals).toEqual({ keysInVault: 0, added: 0, unlocks: 0, refused: 0 });
    expect(out.alerts).toEqual([]);
    expect(out.keyRisk).toEqual([]);
  });

  it("with simulation on, an empty vault still has a demo story, marked as simulated, scores within 0-100", () => {
    const out = buildInsights({ keys: [], audit: [], now: NOW });
    expect(out.alerts.length).toBeGreaterThan(0);
    expect(out.alerts.every((a) => a.simulated)).toBe(true);
    expect(out.keyRisk.every((k) => k.simulated && k.score >= 0 && k.score <= 100)).toBe(true);
    expect(out.vaultRisk).toBeGreaterThanOrEqual(0);
    expect(out.vaultRisk).toBeLessThanOrEqual(100);
    expect(out.alerts.map((a) => a.score)).toEqual([...out.alerts.map((a) => a.score)].sort((x, y) => y - x));
  });
});
