import type { DocumentStatus, DocumentType, SigningStatus, Tier } from "@/api/types";

/** 640.000.000 ₫. Works on digit strings so amounts above 2^53 stay exact. */
export function formatVnd(dong: string | bigint): string {
  const s = typeof dong === "bigint" ? dong.toString() : dong;
  if (!/^\d+$/.test(s)) return "—";
  return `${s.replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ₫`;
}

/** What a person typed ("640.000.000", "640 000 000 ₫") to canonical digits, or null. */
export function parseVndInput(input: string): string | null {
  const digits = input.replace(/[.\s₫,]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const canonical = digits.replace(/^0+(?=\d)/, "");
  return canonical.length > 16 ? null : canonical;
}

/** 640M ₫ style, for tight spaces. */
export function compactVnd(dong: string): string {
  const n = BigInt(/^\d+$/.test(dong) ? dong : "0");
  if (n >= 1_000_000_000n) return `${(Number(n / 10_000_000n) / 100).toLocaleString("vi-VN")} tỷ ₫`;
  if (n >= 1_000_000n) return `${(Number(n / 10_000n) / 100).toLocaleString("vi-VN")} tr ₫`;
  return formatVnd(dong);
}

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

// Vietnamese labels for document types and statuses; English elsewhere for the MVP.
export const DOC_TYPE_LABEL: Record<DocumentType, string> = { payment_voucher: "Phiếu chi", e_invoice: "Hóa đơn" };
export const DOC_TYPE_EN: Record<DocumentType, string> = { payment_voucher: "Payment voucher", e_invoice: "E-invoice" };

export const DOC_STATUS: Record<DocumentStatus, { label: string; tone: "neutral" | "pending" | "approved" }> = {
  draft: { label: "Nháp · Draft", tone: "neutral" },
  pending_approval: { label: "Chờ duyệt · Pending", tone: "pending" },
  signed: { label: "Đã ký · Signed", tone: "approved" },
};

export const REQUEST_STATUS: Record<SigningStatus, { label: string; tone: "neutral" | "pending" | "approved" | "rejected" }> = {
  collecting: { label: "Collecting approvals", tone: "pending" },
  quorum_met: { label: "Ready to sign", tone: "pending" },
  signed: { label: "Signed", tone: "approved" },
  rejected: { label: "Rejected", tone: "rejected" },
  expired: { label: "Expired", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const TIER_LABEL: Record<Tier, string> = { viewer: "Viewer", drafter: "Drafter", approver: "Approver", director: "Director", owner: "Owner" };
export const tierNames = (tiers: Tier[]) => tiers.map((t) => TIER_LABEL[t]).join(", ");

/** Short, plain explanation of a server error code for banners. */
export function describeError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "Something went wrong.";
}
