<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "@/api/client";
import type { TideSetup } from "@/api/types";
import Banner from "@/components/Banner.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { formatTime } from "@/lib/format";
import { signPolicyAsAdmin } from "@/tide/tide";

const setup = ref<TideSetup | null>(null);
const adminPolicy = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref<string | null>(null);

async function load() {
  try {
    setup.value = await api.tideSetup();
    // Fetched up front so the Tide window opens straight from the click.
    if (setup.value.isRealmAdmin && setup.value.directoryAvailable && !adminPolicy.value) adminPolicy.value = (await api.adminPolicy()).policy;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function sign(what: string, unsigned: string, store: (signature: string) => Promise<{ signatureVerified: boolean }>) {
  if (!adminPolicy.value) return;
  error.value = null;
  notice.value = null;
  busy.value = what;
  try {
    const signature = await signPolicyAsAdmin(unsigned, adminPolicy.value);
    const out = await store(signature);
    notice.value = out.signatureVerified
      ? `${what}: signed by the Tide network and verified.`
      : `${what}: stored. The network signed it, but SignGuard could not verify the signature locally; the network still enforces it.`;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

const signRule = (r: TideSetup["rules"][number]) =>
  sign(`Rule ${r.ruleId} (v${r.policyVersion})`, r.unsigned, (s) => api.storeRuleSignature(r.policyVersion, r.ruleId, s));
const signSealed = () => setup.value && sign("Sealed-fields policy", setup.value.sealedFields.unsigned, api.storeSealedSignature);

onMounted(load);
</script>

<template>
  <div class="stack">
    <h1>Tide setup</h1>
    <p class="muted">Each item is approved once by a realm admin in Tide's own window. After that, the Tide network itself enforces it: SignGuard's server cannot change or skip it.</p>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <Banner v-if="notice" tone="approved">{{ notice }}</Banner>
    <SkeletonRows v-if="!setup && !error" />
    <template v-if="setup">
      <Banner v-if="!setup.isRealmAdmin" tone="pending">You are not a realm admin (tide-realm-admin), so you can view but not approve these.</Banner>
      <Banner v-if="!setup.directoryAvailable" tone="rejected">The server has no TideCloak admin credential, so it cannot fetch the realm's admin policy.</Banner>

      <section class="card stack">
        <h2>Sealed fields</h2>
        <p class="small">Lets members holding <code>_tide_decryptor</code> read, and drafters holding <code>_tide_encryptor</code> write, the counterparty, bank account and description, through Tide's built-in <code>RelationshipAttestation:1</code> contract.</p>
        <div class="spread">
          <StatusBadge :tone="setup.sealedFields.configured ? 'approved' : 'pending'" :label="setup.sealedFields.configured ? `Approved by ${setup.sealedFields.signedBy}` : 'Not approved yet'" />
          <button v-if="setup.isRealmAdmin && !setup.sealedFields.configured" class="btn btn-primary" :disabled="!!busy || !adminPolicy" @click="signSealed">Approve in Tide</button>
        </div>
      </section>

      <section class="card stack">
        <h2>Network signing rules</h2>
        <p class="small">One rule per approval band, on Tide's built-in <code>GenericRealmAccessThresholdRole:1</code> contract: the network signs a document's approval statement only once enough approvers holding the role have approved it in Tide.</p>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Policy</th><th>Band</th><th>Network requires</th><th>Status</th><th></th></tr></thead>
            <tbody>
              <tr v-for="r in setup.rules" :key="`${r.policyVersion}:${r.ruleId}`">
                <td>v{{ r.policyVersion }} <span class="muted small">{{ r.policyStatus }}</span></td>
                <td>{{ r.label }}</td>
                <td class="small">≥ {{ r.threshold }} × <code>{{ r.role }}</code></td>
                <td>
                  <StatusBadge :tone="r.signed ? (r.signatureVerified ? 'approved' : 'pending') : 'pending'" :label="r.signed ? (r.signatureVerified ? 'Signed, verified' : 'Signed, not verified locally') : 'Not signed'" />
                  <div v-if="r.signedBy" class="muted small">{{ r.signedBy }}, {{ formatTime(r.signedAt) }}</div>
                </td>
                <td>
                  <button v-if="setup.isRealmAdmin && !r.signed" class="btn btn-primary" :disabled="!!busy || !adminPolicy" @click="signRule(r)">Approve in Tide</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <p v-if="busy" class="muted" role="status">{{ busy }}: confirm in the Tide window…</p>
    </template>
  </div>
</template>
