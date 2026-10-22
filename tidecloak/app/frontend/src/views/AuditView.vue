<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "@/api/client";
import type { AuditRow, AuditVerification } from "@/api/types";
import Banner from "@/components/Banner.vue";
import HashChip from "@/components/HashChip.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { formatTime } from "@/lib/format";

const rows = ref<AuditRow[]>([]);
const numbers = ref(new Map<string, string>());
const verification = ref<AuditVerification | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const EVENT_TONE: Record<string, "neutral" | "pending" | "approved" | "rejected"> = {
  "document.signed": "approved", "signing.approved": "approved", "tide.rule_signed": "approved",
  "signing.rejected": "rejected", "signing.denied_attempt": "rejected", "document.submitted": "pending",
};

async function verify() {
  verification.value = null;
  try {
    verification.value = await api.verifyAudit();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function exportLog() {
  const data = await api.exportAudit();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `signguard-audit-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(url);
}

onMounted(async () => {
  try {
    const [audit, docs] = await Promise.all([api.audit(), api.documents()]);
    rows.value = audit.reverse();
    numbers.value = new Map(docs.map((d) => [d.id, d.number]));
    await verify();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="stack">
    <div class="spread">
      <h1>Audit log</h1>
      <div class="row"><button class="btn" @click="verify">Verify chain</button><button class="btn" @click="exportLog">Export</button></div>
    </div>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <Banner v-if="verification" :tone="verification.ok ? 'approved' : 'rejected'">
      <strong>{{ verification.ok ? "✓ Chain verified" : "✕ Chain broken" }}</strong>
      · {{ verification.length }} entries
      <template v-if="verification.brokenAtSeq !== null"> · first bad entry: #{{ verification.brokenAtSeq }}</template>
      · {{ verification.anchors.length }} Tide-signed anchor{{ verification.anchors.length === 1 ? "" : "s" }}
      ({{ verification.anchors.filter((a) => a.signatureValid && a.matchesLog).length }} match)
      <div class="small muted">The hash chain catches an edited entry; each signed document's approval statement anchors the log head, signed by the Tide network, so rewriting the whole chain is caught too.</div>
    </Banner>
    <SkeletonRows v-if="loading" />
    <div v-else class="card table-wrap">
      <table class="table">
        <thead><tr><th>#</th><th>When</th><th>Event</th><th>Who</th><th>Document</th><th>Hash</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.seq">
            <td class="num">{{ r.seq }}</td>
            <td class="small" style="white-space: nowrap">{{ formatTime(r.at) }}</td>
            <td><StatusBadge :tone="EVENT_TONE[r.event] ?? 'neutral'" :label="r.event" /><div v-if="r.details.reason || r.details.code" class="muted small">{{ r.details.reason ?? r.details.code }}</div></td>
            <td>{{ r.actor.name }}</td>
            <td><RouterLink v-if="r.documentId" :to="`/documents/${r.documentId}`" class="small">{{ numbers.get(r.documentId) ?? (r.details.number as string) ?? "open" }}</RouterLink></td>
            <td><HashChip :hash="r.hash" /></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
