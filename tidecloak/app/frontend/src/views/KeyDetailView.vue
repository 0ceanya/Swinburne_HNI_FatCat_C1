<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/api/client";
import type { KeyRequest, VaultKey } from "@/api/types";
import Banner from "@/components/Banner.vue";
import HashChip from "@/components/HashChip.vue";
import LevelBadge from "@/components/LevelBadge.vue";
import QuorumProgress from "@/components/QuorumProgress.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { requestRelease, STEP_TEXT, type Step } from "@/flows/vault";
import { formatTime, KEY_STATUS, kindLabel, OPERATION_LABEL, quorumText, REQUEST_STATUS } from "@/lib/format";
import { useSession } from "@/stores/session";
import * as tide from "@/tide/tide";

const props = defineProps<{ id: string }>();
const router = useRouter();
const session = useSession();
const key = ref<VaultKey | null>(null);
const requests = ref<KeyRequest[]>([]);
const error = ref<string | null>(null);
const reason = ref("");
const step = ref<Step | null>(null);

const myOpen = computed(() => requests.value.find((r) => r.operation === "release" && ["collecting", "ready"].includes(r.status) && r.requester.memberId === session.me?.id) ?? null);
const ciphertextTail = computed(() => (key.value?.ciphertext ? Array.from(tide.fromBase64(key.value.ciphertext).slice(-16), (b) => b.toString(16).padStart(2, "0")).join("") : null));

async function load() {
  try {
    const out = await api.key(props.id);
    key.value = out.key;
    requests.value = out.requests;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function ask() {
  if (!key.value || reason.value.trim().length < 3) return;
  error.value = null;
  try {
    const req = await requestRelease({ tide, api }, key.value, reason.value.trim(), (s) => (step.value = s));
    await router.push(`/requests/${req.id}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    step.value = null;
  }
}

onMounted(load);
</script>

<template>
  <SkeletonRows v-if="!key && !error" :rows="2" />
  <Banner v-else-if="!key" tone="rejected">{{ error }}</Banner>
  <div v-else class="stack">
    <RouterLink to="/vault" class="small">← Vault</RouterLink>
    <div class="spread">
      <h1 style="margin: 0">{{ key.name }}</h1>
      <StatusBadge :tone="KEY_STATUS[key.status].tone" :label="KEY_STATUS[key.status].label" />
    </div>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>

    <div class="grid-2">
      <section class="card">
        <dl class="fields">
          <dt>Type</dt><dd>{{ kindLabel(session.config?.kinds, key.kind) }}</dd>
          <dt>Provider</dt><dd>{{ key.provider || "—" }}</dd>
          <dt>Level</dt><dd><LevelBadge :level="key.level" :quorum="key.quorum" /></dd>
          <dt>Unlocking needs</dt><dd>{{ quorumText(key.level, session.config?.boardSize ?? key.quorum) }}</dd>
          <dt v-if="key.description">What it is for</dt><dd v-if="key.description">{{ key.description }}</dd>
          <dt v-if="key.hint">Hint</dt><dd v-if="key.hint" class="mono">{{ key.hint }}</dd>
          <dt>Added by</dt><dd>{{ key.createdBy.name }}, {{ formatTime(key.createdAt) }}</dd>
          <dt>Sealed</dt><dd>{{ key.sealedAt ? formatTime(key.sealedAt) : "not yet" }}</dd>
          <dt>Unlocked</dt><dd>{{ key.releaseCount }} time{{ key.releaseCount === 1 ? "" : "s" }}{{ key.lastReleasedAt ? `, last by ${key.lastReleasedTo?.name} ${formatTime(key.lastReleasedAt)}` : "" }}</dd>
          <dt v-if="ciphertextTail">Ciphertext</dt><dd v-if="ciphertextTail"><HashChip :hash="ciphertextTail" /> <span class="muted small">only the Tide network can open it</span></dd>
        </dl>
      </section>

      <aside class="stack">
        <section v-if="key.status === 'active'" class="card stack">
          <h2>Request access</h2>
          <template v-if="myOpen">
            <p>You already asked. <RouterLink :to="`/requests/${myOpen.id}`">Open your request</RouterLink></p>
          </template>
          <form v-else class="stack" @submit.prevent="ask">
            <p class="small muted">{{ key.quorum === 1 ? "Level 1: you can unlock it yourself; it is logged." : `${key.quorum - 1} other board member${key.quorum === 2 ? "" : "s"} must approve in Tide before the network decrypts it for you.` }}</p>
            <div class="field"><label for="why">Why do you need it?</label><textarea id="why" v-model="reason" required maxlength="500" placeholder="e.g. Sign the Q3 e-invoices for Công ty Minh Phát" /></div>
            <button type="submit" class="btn btn-primary" :disabled="reason.trim().length < 3 || !!step">Ask the board</button>
            <p v-if="step" class="muted small" role="status">{{ STEP_TEXT[step] }}</p>
          </form>
        </section>
        <section class="card">
          <h2>History</h2>
          <p v-if="requests.length === 0" class="muted">No requests yet.</p>
          <ul v-else class="history">
            <li v-for="r in requests" :key="r.id">
              <RouterLink :to="`/requests/${r.id}`">{{ OPERATION_LABEL[r.operation] }}</RouterLink> by {{ r.requester.name }}
              <div class="row small" style="gap: 0.5rem"><StatusBadge :tone="REQUEST_STATUS[r.status].tone" :label="REQUEST_STATUS[r.status].label" /><QuorumProgress :request="r" /><span class="muted">{{ formatTime(r.createdAt) }}</span></div>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.history { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
</style>
