<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "@/api/client";
import type { Policy, PolicyRule } from "@/api/types";
import Banner from "@/components/Banner.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { formatTime, formatVnd, parseVndInput, TIER_LABEL } from "@/lib/format";
import { describeRange } from "@/lib/policy";
import { useSession } from "@/stores/session";

const session = useSession();
const policies = ref<Policy[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const editing = ref(false);
const draftRules = ref<PolicyRule[]>([]);
const reason = ref("");

const active = computed(() => policies.value.find((p) => p.status === "active") ?? null);
const proposed = computed(() => policies.value.find((p) => p.status === "proposed") ?? null);

async function load() {
  try {
    policies.value = await api.policies();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function startEdit() {
  if (!active.value) return;
  draftRules.value = active.value.rules.map((r) => ({ ...r, requiredTiers: r.requiredTiers.map((t) => ({ ...t })), network: { ...r.network } }));
  reason.value = "";
  editing.value = true;
}

/** Keep the bands contiguous: editing a band's upper bound moves the next band's lower bound. */
function setMax(i: number, input: string) {
  const v = parseVndInput(input);
  const rule = draftRules.value[i];
  if (!rule || v === null) return;
  rule.maxDong = v;
  const next = draftRules.value[i + 1];
  if (next) next.minDong = (BigInt(v) + 1n).toString();
}

async function act(fn: () => Promise<unknown>, done: string) {
  error.value = null;
  notice.value = null;
  try {
    await fn();
    notice.value = done;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

const needs = (r: PolicyRule) => (r.initiatorMayApprove ? "Drafter alone (logged)"
  : "Drafter + " + r.requiredTiers.map((t) => (t.count > 1 ? `${t.count}× ` : "") + TIER_LABEL[t.tier]).join(" + "));
const endorse = (p: Policy) => act(() => api.endorsePolicy(p.version), "Endorsed.");
const activate = (p: Policy) => act(() => api.activatePolicy(p.version), `Version ${p.version} is now active.`);

const propose = () => act(async () => { await api.proposePolicy(draftRules.value, reason.value); editing.value = false; },
  "Proposed. A realm admin must sign its network rules in Tide setup, and a second director or owner must endorse it.");

onMounted(load);
</script>

<template>
  <div class="stack">
    <h1>Approval policy</h1>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <Banner v-if="notice" tone="approved">{{ notice }}</Banner>
    <SkeletonRows v-if="loading" :rows="2" />

    <template v-for="p in [active, proposed].filter(Boolean) as Policy[]" :key="p.version">
      <section class="card stack">
        <div class="spread">
          <h2 style="margin: 0">Version {{ p.version }}</h2>
          <StatusBadge :tone="p.status === 'active' ? 'approved' : 'pending'" :label="p.status === 'active' ? 'Active' : 'Proposed, waiting for approval'" />
        </div>
        <p class="muted small">{{ p.reason }} · proposed by {{ p.proposedBy.name }}, {{ formatTime(p.proposedAt) }}</p>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Amount</th><th>Needs</th><th>Tide network enforces</th><th v-if="p.status === 'proposed'">Network rule</th></tr></thead>
            <tbody>
              <tr v-for="r in p.rules" :key="r.id">
                <td class="num">{{ describeRange(r, formatVnd) }}</td>
                <td>{{ needs(r) }}</td>
                <td class="small">≥ {{ r.network.threshold }} approver{{ r.network.threshold > 1 ? "s" : "" }} holding <code>{{ r.network.role }}</code></td>
                <td v-if="p.status === 'proposed'"><StatusBadge :tone="r.networkSigned ? 'approved' : 'pending'" :label="r.networkSigned ? 'Signed' : 'Not signed'" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <template v-if="p.status === 'proposed'">
          <p class="small">Endorsed by: {{ p.endorsements.map((e) => e.name).join(", ") || "nobody yet" }}</p>
          <div class="row">
            <button v-if="session.has('director', 'owner') && p.proposedBy.id !== session.me?.id" class="btn" @click="endorse(p)">Endorse this change</button>
            <button v-if="session.has('owner')" class="btn btn-primary" @click="activate(p)">Activate</button>
            <RouterLink v-if="session.me?.isRealmAdmin" to="/setup" class="btn">Sign network rules</RouterLink>
          </div>
        </template>
      </section>
    </template>

    <p class="muted small">Changing approvers or policy needs the owner plus one other person: a second director or owner endorses here, and realm admins sign the new network rules in Tide's own window. A request keeps the policy version it started with.</p>

    <button v-if="session.has('owner') && active && !proposed && !editing" class="btn" @click="startEdit">Propose a change</button>
    <form v-if="editing" class="card stack" @submit.prevent="propose">
      <h2>Propose a change to version {{ active?.version }}</h2>
      <div v-for="(r, i) in draftRules" :key="r.id" class="card">
        <div class="field"><label :for="`lbl-${r.id}`">Label</label><input :id="`lbl-${r.id}`" v-model="r.label" /></div>
        <div class="row">
          <div><label>From (₫)</label><input :value="r.minDong" disabled class="num" /></div>
          <div v-if="r.maxDong !== null"><label :for="`max-${r.id}`">Up to (₫)</label><input :id="`max-${r.id}`" :value="r.maxDong" inputmode="numeric" class="num" @change="setMax(i, ($event.target as HTMLInputElement).value)" /></div>
          <div v-else><label>Up to</label><input value="no limit" disabled /></div>
        </div>
      </div>
      <div class="field"><label for="reason">Why is it changing?</label><textarea id="reason" v-model="reason" required /></div>
      <div class="row"><button type="button" class="btn" @click="editing = false">Cancel</button><button type="submit" class="btn btn-primary" :disabled="!reason.trim()">Propose</button></div>
    </form>
  </div>
</template>
