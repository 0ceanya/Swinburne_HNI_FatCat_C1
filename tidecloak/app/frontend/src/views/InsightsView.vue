<script setup lang="ts">
/**
 * Security insights for the owner / realm admin. The counts come from the audit log; the risk
 * scores, alerts and verdicts come from a SIMULATED model (src/lib/riskModel.ts) for the demo.
 */
import { computed, onMounted, ref, watch } from "vue";
import { api } from "@/api/client";
import type { AuditRow, VaultKey } from "@/api/types";
import Banner from "@/components/Banner.vue";
import LineChart from "@/components/LineChart.vue";
import RiskBars from "@/components/RiskBars.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { formatTime, timeAgo } from "@/lib/format";
import { buildInsights, riskBand, SEVERITY } from "@/lib/riskModel";

const SIM_KEY = "signguard.insights.simulate";
const keys = ref<VaultKey[]>([]);
const audit = ref<AuditRow[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const simulate = ref(true);
try { simulate.value = localStorage.getItem(SIM_KEY) !== "0"; } catch { /* private mode */ }
watch(simulate, (v) => { try { localStorage.setItem(SIM_KEY, v ? "1" : "0"); } catch { /* private mode */ } });

const insights = computed(() => buildInsights({ keys: keys.value, audit: audit.value, simulate: simulate.value }));
const openCritical = computed(() => insights.value.alerts.filter((a) => a.severity === "critical").length);
const series = computed(() => [
  { name: "Unlocks", color: "var(--series-1)", values: insights.value.days.map((d) => d.unlocks) },
  { name: "Keys added", color: "var(--series-2)", values: insights.value.days.map((d) => d.added) },
  { name: "Refused attempts", color: "var(--series-3)", values: insights.value.days.map((d) => d.refused) },
]);
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });

onMounted(async () => {
  try {
    const [k, a] = await Promise.all([api.keys(), api.audit()]);
    keys.value = k;
    audit.value = a;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="stack viz-root">
    <div class="spread">
      <div>
        <h1 style="margin: 0">Security insights</h1>
        <p class="muted small" style="margin: 0">Last 14 days · scored by the risk model</p>
      </div>
      <span class="badge tone-sealed" title="Scores are generated for the demo, not learned">🧠 AI risk model · simulated</span>
    </div>

    <Banner tone="neutral">
      <strong>Demo data.</strong> Counts of real vault activity come from the audit log. The risk model, its scores and its alerts are simulated for this demo.
      A real model would see only this metadata (who, which key, when), never a secret.
      <label class="row small sim-toggle"><input v-model="simulate" type="checkbox" /> Include simulated history</label>
    </Banner>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <SkeletonRows v-if="loading" :rows="3" />

    <template v-else>
      <section class="tiles" aria-label="Summary">
        <div class="card tile hero" :data-band="riskBand(insights.vaultRisk)">
          <div class="muted small">Vault risk</div>
          <div class="big num">{{ insights.vaultRisk }}<span class="of">/100</span></div>
          <StatusBadge :tone="insights.vaultRisk >= 70 ? 'rejected' : insights.vaultRisk >= 40 ? 'pending' : 'approved'" :label="riskBand(insights.vaultRisk)" />
        </div>
        <div class="card tile"><div class="muted small">Unauthorized attempts</div><div class="big num">{{ insights.totals.refused }}</div><div class="muted small">refused by SignGuard</div></div>
        <div class="card tile"><div class="muted small">Potential fraud alerts</div><div class="big num">{{ insights.alerts.length }}</div><div class="muted small">{{ openCritical }} critical</div></div>
        <div class="card tile"><div class="muted small">Keys added</div><div class="big num">{{ insights.totals.added }}</div><div class="muted small">{{ insights.totals.keysInVault }} sealed in the vault now</div></div>
        <div class="card tile"><div class="muted small">Unlocks</div><div class="big num">{{ insights.totals.unlocks }}</div><div class="muted small">each with a full quorum</div></div>
      </section>

      <section class="card stack">
        <h2 style="margin: 0">Vault activity per day</h2>
        <LineChart title="Vault activity per day: unlocks, keys added and refused attempts" :labels="insights.days.map((d) => d.date)" :series="series" :format-label="dayLabel" />
      </section>

      <div class="grid-2">
        <section class="card stack">
          <div class="spread"><h2 style="margin: 0">Potential fraud</h2><span class="muted small">{{ insights.alerts.length }} flagged by the model</span></div>
          <p v-if="insights.alerts.length === 0" class="muted">Nothing flagged in the last 14 days.</p>
          <ul v-else class="alerts">
            <li v-for="a in insights.alerts" :key="a.id" class="alert">
              <div class="spread">
                <StatusBadge :tone="SEVERITY[a.severity].tone" :label="`${SEVERITY[a.severity].label} · ${a.score}`" />
                <span class="muted small">{{ timeAgo(a.at) }}{{ a.simulated ? " · simulated" : "" }}</span>
              </div>
              <strong>{{ a.title }}</strong>
              <div class="small">{{ a.actor }}{{ a.keyName ? ` · ${a.keyName}` : "" }}</div>
              <div class="muted small">{{ a.detail }}</div>
            </li>
          </ul>
        </section>

        <section class="card stack">
          <h2 style="margin: 0">Risk score per key</h2>
          <p class="muted small" style="margin: 0">0-100 from the key's level, how often it left the vault, and alerts on it. Hover for the reasons.</p>
          <p v-if="insights.keyRisk.length === 0" class="muted">No sealed keys yet.</p>
          <RiskBars v-else :items="insights.keyRisk" :threshold="70" />
        </section>
      </div>

      <section class="card stack">
        <h2 style="margin: 0">Activity log, with the model's verdict</h2>
        <p v-if="insights.activity.length === 0" class="muted">No activity recorded yet.</p>
        <div v-else class="table-wrap">
          <table class="table">
            <thead><tr><th>#</th><th>When</th><th>Event</th><th>Who</th><th>Key</th><th>Model</th></tr></thead>
            <tbody>
              <tr v-for="r in insights.activity" :key="r.seq">
                <td class="num">{{ r.seq }}</td>
                <td class="small" style="white-space: nowrap">{{ formatTime(r.at) }}</td>
                <td><code class="small">{{ r.event }}</code></td>
                <td>{{ r.actor }}</td>
                <td class="small">{{ r.keyName ?? "—" }}</td>
                <td><StatusBadge :tone="r.verdict === 'unusual' ? 'rejected' : 'approved'" :label="r.verdict === 'unusual' ? 'Unusual' : 'Normal'" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* Series colours, validated for both surfaces (dataviz validate_palette: all pairs, light #ffffff, dark #171b22). */
.viz-root { --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; }
@media (prefers-color-scheme: dark) {
  .viz-root { --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; }
}
.tiles { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); }
.tile { display: grid; gap: 0.2rem; align-content: start; justify-items: start; }
.big { font-size: 1.75rem; font-weight: 700; line-height: 1.1; }
.of { font-size: 0.9rem; font-weight: 500; color: var(--muted); margin-left: 0.15rem; }
.hero .big { font-size: 2.1rem; }
.alerts { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
.alert { display: grid; gap: 0.2rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--border); }
.alert:last-child { border-bottom: none; padding-bottom: 0; }
.sim-toggle { gap: 0.4rem; margin: 0.5rem 0 0; font-weight: 400; }
.sim-toggle input { width: auto; min-height: auto; }
</style>
