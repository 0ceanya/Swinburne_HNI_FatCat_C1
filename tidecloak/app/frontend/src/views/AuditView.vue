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
const names = ref(new Map<string, string>());
const verification = ref<AuditVerification | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const EVENT_TONE: Record<string, "neutral" | "pending" | "approved" | "rejected" | "sealed"> = {
  "key.sealed": "sealed", "release.completed": "approved", "request.approved": "approved", "tide.vault_policy_signed": "approved",
  "request.rejected": "rejected", "request.denied_attempt": "rejected", "key.registered": "pending", "release.requested": "pending",
  "request.finish_started": "pending",
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
    const [audit, keys] = await Promise.all([api.audit(), api.keys()]);
    rows.value = audit.reverse();
    names.value = new Map(keys.map((k) => [k.id, k.name]));
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
      <div class="small muted">Every entry hashes the one before it, so editing any past entry breaks the chain from that point.</div>
    </Banner>
    <SkeletonRows v-if="loading" />
    <div v-else class="card table-wrap">
      <table class="table">
        <thead><tr><th>#</th><th>When</th><th>Event</th><th>Who</th><th>Key</th><th>Hash</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.seq">
            <td class="num">{{ r.seq }}</td>
            <td class="small" style="white-space: nowrap">{{ formatTime(r.at) }}</td>
            <td><StatusBadge :tone="EVENT_TONE[r.event] ?? 'neutral'" :label="r.event" /><div v-if="r.details.reason || r.details.code" class="muted small">{{ r.details.reason ?? r.details.code }}</div><div v-if="Array.isArray(r.details.approvedBy)" class="muted small">approved by {{ (r.details.approvedBy as string[]).join(", ") }}</div></td>
            <td>{{ r.actor.name }}</td>
            <td><RouterLink v-if="r.keyId" :to="`/vault/${r.keyId}`" class="small">{{ names.get(r.keyId) ?? (r.details.name as string) ?? "open" }}</RouterLink></td>
            <td><HashChip :hash="r.hash" /></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
