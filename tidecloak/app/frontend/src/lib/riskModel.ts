import type { AuditRow, Level, VaultKey } from "@/api/types";

/**
 * A SIMULATED risk model, for the demo dashboard only. Nothing here is learned: real events from
 * the audit log are scored by fixed rules, and "simulated history" adds generated events so the
 * charts have something to show. A seeded generator keeps the numbers the same for the whole day,
 * so a recording or a screenshot does not change on reload.
 *
 * A real model would only ever see this metadata (who, which key, when): vault secrets are
 * encrypted in the browser and never reach the server.
 */

export type Severity = "critical" | "high" | "watch";

export interface DayActivity {
  date: string;
  added: number;
  unlocks: number;
  refused: number;
}

export interface Alert {
  id: string;
  at: string;
  severity: Severity;
  score: number;
  title: string;
  detail: string;
  keyName: string | null;
  actor: string;
  simulated: boolean;
}

export interface KeyRisk {
  keyId: string;
  name: string;
  level: Level;
  score: number;
  drivers: string[];
  simulated: boolean;
}

export interface ActivityRow {
  seq: number;
  at: string;
  event: string;
  actor: string;
  keyName: string | null;
  verdict: "normal" | "unusual";
}

export interface Insights {
  days: DayActivity[];
  totals: { keysInVault: number; added: number; unlocks: number; refused: number };
  alerts: Alert[];
  keyRisk: KeyRisk[];
  activity: ActivityRow[];
  /** 0-100, the mean of the three riskiest keys and the open alerts. */
  vaultRisk: number;
}

/** mulberry32: small, fast, and the same sequence for the same seed. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), h = (h << 13) | (h >>> 19);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_PEOPLE = ["Nguyễn Văn An", "Lê Văn Cường", "Trần Thị Bình"];
const DEMO_KEYS: { name: string; level: Level }[] = [
  { name: "Viettel MySign: company signature", level: 3 },
  { name: "AWS root", level: 4 },
  { name: "Vietcombank e-banking", level: 3 },
  { name: "Stripe live key", level: 2 },
  { name: "Production database", level: 2 },
];

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const hourOf = (iso: string) => new Date(iso).getHours();
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function buildInsights(input: { keys: VaultKey[]; audit: AuditRow[]; now?: Date; days?: number; simulate?: boolean }): Insights {
  const now = input.now ?? new Date();
  const span = input.days ?? 14;
  const simulate = input.simulate ?? true;
  const rand = seededRandom(`signguard-${dayKey(now)}`);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

  const keyName = new Map(input.keys.map((k) => [k.id, k.name]));
  const since = new Date(now.getTime() - (span - 1) * 86400000);
  since.setHours(0, 0, 0, 0);
  const recent = input.audit.filter((e) => new Date(e.at) >= since);

  // --- daily activity: real events, plus simulated history ---
  const days: DayActivity[] = Array.from({ length: span }, (_, i) => {
    const d = new Date(since.getTime() + i * 86400000);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    return {
      date: dayKey(d),
      added: simulate && !weekend && rand() < 0.2 ? 1 : 0,
      unlocks: simulate ? (weekend ? int(0, 1) : int(1, 6)) : 0,
      refused: simulate ? (rand() < 0.22 ? int(1, 2) : 0) : 0,
    };
  });
  const byDay = new Map(days.map((d) => [d.date, d]));
  for (const e of recent) {
    const d = byDay.get(dayKey(new Date(e.at)));
    if (!d) continue;
    if (e.event === "key.registered") d.added++;
    else if (e.event === "release.completed") d.unlocks++;
    else if (e.event === "request.denied_attempt") d.refused++;
  }

  // --- alerts: real events scored by rules, plus simulated ones ---
  const alerts: Alert[] = [];
  const nameFor = (e: AuditRow) => (e.keyId ? keyName.get(e.keyId) ?? String(e.details.name ?? "a key") : null);
  for (const e of recent) {
    if (e.event === "request.denied_attempt") {
      const code = String(e.details.code ?? "");
      alerts.push({
        id: `real-${e.seq}`, at: e.at, severity: "critical", score: code === "REQUESTER_APPROVES_AT_FINISH" ? 92 : 88,
        title: code === "REQUESTER_APPROVES_AT_FINISH" ? "Tried to approve their own request" : "Unauthorized approval attempt",
        detail: `Refused by SignGuard (${code || "denied"}). The Đồng Tháp pattern: one person acting as both sides.`,
        keyName: nameFor(e), actor: e.actor.name, simulated: false,
      });
    } else if (e.event === "release.completed" && (hourOf(e.at) < 7 || hourOf(e.at) >= 20)) {
      alerts.push({
        id: `real-${e.seq}`, at: e.at, severity: "high", score: 74, title: "Unlocked outside business hours",
        detail: `Released at ${new Date(e.at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}; this key is normally used 08:00-18:00.`,
        keyName: nameFor(e), actor: e.actor.name, simulated: false,
      });
    }
  }
  const people = [...new Set(input.audit.map((e) => e.actor.name).filter((n) => n !== "SignGuard"))];
  const peoplePool = people.length ? people : DEMO_PEOPLE;
  const keyPool = input.keys.length ? input.keys.map((k) => ({ name: k.name, level: k.level })) : DEMO_KEYS;
  if (simulate) {
    const templates: { severity: Severity; score: [number, number]; title: string; detail: string }[] = [
      { severity: "critical", score: [85, 95], title: "Unauthorized access attempt", detail: "A session without a board seat tried to approve an unlock." },
      { severity: "high", score: [68, 80], title: "Unusual unlock frequency", detail: "3 unlock requests in 40 minutes; this key averages 1 a month." },
      { severity: "high", score: [62, 75], title: "Unlocked outside business hours", detail: "Released at 02:14; this key is normally used 08:00-18:00." },
      { severity: "watch", score: [40, 55], title: "Vague reason given", detail: "Reason \"need it\" does not say what the key is for." },
      { severity: "watch", score: [35, 50], title: "Same approver pair every time", detail: "The last 6 unlocks were approved by the same two people." },
    ];
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i]!;
      if (i > 1 && rand() < 0.3) continue;
      // Anchored to the start of the window, not to "now", so the same day always gives the same times.
      const at = new Date(since.getTime() + int(1, (span - 1) * 24 - 1) * 3600000).toISOString();
      alerts.push({
        id: `sim-${i}`, at, severity: t.severity, score: int(t.score[0], t.score[1]), title: t.title, detail: t.detail,
        keyName: pick(keyPool).name, actor: pick(peoplePool), simulated: true,
      });
      // A simulated refused attempt is also a refused attempt on that day's chart and in the total.
      if (t.severity === "critical") { const d = byDay.get(dayKey(new Date(at))); if (d) d.refused++; }
    }
  }
  alerts.sort((a, b) => b.score - a.score);

  // --- risk per key: level, how often it leaves the vault, recency ---
  const keyRisk: KeyRisk[] = (input.keys.length ? input.keys.filter((k) => k.status === "active").map((k) => ({ k, simulated: false }))
    : simulate ? DEMO_KEYS.map((d, i) => ({ k: { id: `demo-${i}`, name: d.name, level: d.level, releaseCount: int(0, 9), lastReleasedAt: null } as unknown as VaultKey, simulated: true })) : [])
    .map(({ k, simulated }) => {
      const releases = k.releaseCount + (simulate ? int(0, 4) : 0);
      const flagged = alerts.filter((a) => a.keyName === k.name).length;
      const score = clamp(k.level * 12 + releases * 5 + flagged * 9 + (simulate ? int(0, 10) : 0));
      const drivers = [`Level ${k.level}`, `${releases} unlock${releases === 1 ? "" : "s"} in ${span} days`, ...(flagged ? [`${flagged} alert${flagged === 1 ? "" : "s"}`] : [])];
      return { keyId: k.id, name: k.name, level: k.level, score, drivers, simulated };
    })
    .sort((a, b) => b.score - a.score);

  // --- activity log with the model's verdict ---
  const flaggedSeqs = new Set(alerts.filter((a) => !a.simulated).map((a) => Number(a.id.slice(5))));
  const activity: ActivityRow[] = [...input.audit].sort((a, b) => b.seq - a.seq).slice(0, 12).map((e) => ({
    seq: e.seq, at: e.at, event: e.event, actor: e.actor.name, keyName: nameFor(e),
    verdict: flaggedSeqs.has(e.seq) || e.event === "request.denied_attempt" ? "unusual" : "normal",
  }));

  const totals = {
    keysInVault: input.keys.filter((k) => k.status === "active").length,
    added: days.reduce((n, d) => n + d.added, 0),
    unlocks: days.reduce((n, d) => n + d.unlocks, 0),
    refused: days.reduce((n, d) => n + d.refused, 0),
  };
  const top = keyRisk.slice(0, 3).map((k) => k.score);
  const alertWeight = alerts.reduce((n, a) => n + (a.severity === "critical" ? 18 : a.severity === "high" ? 9 : 3), 0);
  const vaultRisk = clamp((top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0) * 0.6 + Math.min(alertWeight, 40));

  return { days, totals, alerts, keyRisk, activity, vaultRisk };
}

export const SEVERITY: Record<Severity, { label: string; tone: "rejected" | "pending" | "neutral"; icon: string }> = {
  critical: { label: "Critical", tone: "rejected", icon: "✕" },
  high: { label: "High", tone: "pending", icon: "●" },
  watch: { label: "Watch", tone: "neutral", icon: "○" },
};

export const riskBand = (score: number) => (score >= 70 ? "High" : score >= 40 ? "Moderate" : "Low");
