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
const busy = ref<number | null>(null);

async function load() {
  try {
    setup.value = await api.tideSetup();
    // Fetched up front so the Tide window opens straight from the click.
    if (setup.value.isRealmAdmin && setup.value.directoryAvailable && !adminPolicy.value) adminPolicy.value = (await api.adminPolicy()).policy;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function sign(p: TideSetup["policies"][number]) {
  if (!adminPolicy.value) return;
  error.value = null;
  notice.value = null;
  busy.value = p.threshold;
  try {
    const signature = await signPolicyAsAdmin(p.unsigned, adminPolicy.value);
    const out = await api.storeVaultPolicy(p.threshold, signature);
    notice.value = out.signatureVerified
      ? `${p.threshold}-approval policy: signed by the Tide network and verified.`
      : `${p.threshold}-approval policy: stored. The network signed it, but SignGuard could not verify the signature locally; the network still enforces it.`;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="stack">
    <h1>Tide setup</h1>
    <p class="muted">One network policy per number of approvals. A realm admin approves each once, in Tide's own window. After that the Tide network itself refuses to seal or unlock a key without that many board approvals: SignGuard's server cannot change or skip it.</p>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <Banner v-if="notice" tone="approved">{{ notice }}</Banner>
    <SkeletonRows v-if="!setup && !error" />
    <template v-if="setup">
      <Banner v-if="!setup.isRealmAdmin" tone="pending">You are not a realm admin (tide-realm-admin), so you can view but not approve these.</Banner>
      <Banner v-if="!setup.directoryAvailable" tone="rejected">The server has no TideCloak admin credential, so it cannot fetch the realm's admin policy to sign under.</Banner>
      <section class="card stack">
        <h2>Vault policies</h2>
        <p class="small">Each is Tide's built-in <code>GenericRealmAccessThresholdRole:1</code> over <code>PolicyEnabledEncryption:1</code> and <code>PolicyEnabledDecryption:1</code>, with explicit approvals from holders of <code>sg_viewer</code> (every board member).</p>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Approvals</th><th>Used by</th><th>Status</th><th></th></tr></thead>
            <tbody>
              <tr v-for="p in setup.policies" :key="p.threshold">
                <td><strong>{{ p.threshold }} of {{ setup.boardSize }}</strong></td>
                <td class="small">{{ p.keysUsing }} key{{ p.keysUsing === 1 ? "" : "s" }}</td>
                <td>
                  <StatusBadge :tone="p.signed ? (p.signatureVerified ? 'approved' : 'pending') : 'pending'" :label="p.signed ? (p.signatureVerified ? 'Signed, verified' : 'Signed, not verified locally') : 'Not signed'" />
                  <div v-if="p.signedBy" class="muted small">{{ p.signedBy }}, {{ formatTime(p.signedAt) }}</div>
                </td>
                <td><button v-if="setup.isRealmAdmin && !p.signed" class="btn btn-primary" :disabled="busy !== null || !adminPolicy" @click="sign(p)">Approve in Tide</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <p v-if="busy !== null" class="muted" role="status">{{ busy }}-approval policy: confirm in the Tide window…</p>
    </template>
  </div>
</template>
