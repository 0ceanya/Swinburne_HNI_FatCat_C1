import type { KeyKind, KeyStatus, Level, Operation, RequestStatus, Tier } from "@/api/types";

export const shortHash = (hex: string | null | undefined) => (hex && hex.length >= 8 ? `${hex.slice(0, 4)}…${hex.slice(-4)}` : "—");

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export type Tone = "neutral" | "pending" | "approved" | "rejected" | "sealed";

export const LEVEL_LABEL: Record<Level, string> = { 1: "Standard", 2: "Elevated", 3: "High", 4: "Critical" };
export const LEVEL_TONE: Record<Level, Tone> = { 1: "neutral", 2: "pending", 3: "sealed", 4: "rejected" };

export const KEY_STATUS: Record<KeyStatus, { label: string; tone: Tone }> = {
  pending_seal: { label: "Waiting for the board to seal", tone: "pending" },
  active: { label: "Sealed in the vault", tone: "sealed" },
  rejected: { label: "Not sealed", tone: "neutral" },
};

export const OPERATION_LABEL: Record<Operation, string> = { seal: "Seal into the vault", release: "Unlock" };

export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
  collecting: { label: "Collecting approvals", tone: "pending" },
  ready: { label: "Approved, waiting for the requester to finish", tone: "pending" },
  completed: { label: "Done", tone: "approved" },
  rejected: { label: "Rejected", tone: "rejected" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

export const TIER_LABEL: Record<Tier, string> = { viewer: "Viewer", drafter: "Accountant", approver: "Approver", director: "Director", owner: "Owner" };
export const tierNames = (tiers: Tier[]) => tiers.map((t) => TIER_LABEL[t]).join(", ");

export const kindLabel = (kinds: KeyKind[] | undefined, id: string) => kinds?.find((k) => k.id === id)?.label ?? id;

/** "3 of 3 people", with a note when the level asks for more people than the board has. */
export function quorumText(level: Level, boardSize: number): string {
  const n = Math.min(level, boardSize);
  const people = n === 1 ? "1 person (the requester alone, logged)" : `${n} of ${boardSize} board members`;
  return level > boardSize ? `${people}: level ${level} is capped at the board size` : people;
}

/**
 * A secret may be a file (a .p12 certificate, a key file). It is stored as a data URL so the same
 * text round-trips through Tide's encryption and can be downloaded again after unlocking.
 */
export function parseFileSecret(secret: string): { name: string; mime: string; base64: string } | null {
  const m = /^data:([^;,]*);name=([^;,]*);base64,([A-Za-z0-9+/=]*)$/.exec(secret);
  return m ? { mime: m[1] || "application/octet-stream", name: decodeURIComponent(m[2]!), base64: m[3]! } : null;
}

export const fileSecret = (name: string, mime: string, base64: string) => `data:${mime || "application/octet-stream"};name=${encodeURIComponent(name)};base64,${base64}`;

export function describeError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "Something went wrong.";
}
