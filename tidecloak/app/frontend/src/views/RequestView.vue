<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, ApiError } from "@/api/client";
import type { KeyRequest, VaultKey } from "@/api/types";
import Banner from "@/components/Banner.vue";
import LevelBadge from "@/components/LevelBadge.vue";
import QuorumProgress from "@/components/QuorumProgress.vue";
import SecretReveal from "@/components/SecretReveal.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { approve as approveFlow, finish as finishFlow, STEP_TEXT, type Step } from "@/flows/vault";
import { formatTime, kindLabel, OPERATION_LABEL, REQUEST_STATUS, timeAgo } from "@/lib/format";
import { useSession } from "@/stores/session";
import * as tide from "@/tide/tide";

const props = defineProps<{ id: string }>();
const session = useSession();
const deps = { tide, api };

const req = ref<KeyRequest | null>(null);
const key = ref<VaultKey | null>(null);
const error = ref<string | null>(null);
const step = ref<Step | null>(null);
const rejecting = ref(false);
const reason = ref("");
/** Release only: held in memory for the reveal panel, never stored or sent. */
const secret = ref<string | null>(null);

const meId = computed(() => session.me?.id);
const open = computed(() => !!req.value && ["collecting", "ready"].includes(req.value.status));
const isRequester = computed(() => !!req.value && req.value.requester.memberId === meId.value);
const alreadyApproved = computed(() => !!req.value?.approvals.some((a) => a.memberId === meId.value));
const remaining = computed(() => (req.value ? Math.max(0, req.value.othersNeeded - req.value.approvals.length) : 0));
const canApprove = computed(() => !!req.value && req.value.status === "collecting" && session.onBoard && !isRequester.value && !alreadyApproved.value);
const canFinish = computed(() => !!req.value && req.value.status === "ready" && isRequester.value);
const whyNot = computed(() => {
  const r = req.value;
  if (!r || !open.value) return null;
  if (isRequester.value && r.status === "collecting") {
    return `You asked for this. Waiting for ${remaining.value} more approval${remaining.value === 1 ? "" : "s"} from the board; you add yours last, when you finish.`;
  }
  if (alreadyApproved.value) return r.status === "ready" ? `You approved. ${r.requester.name} can finish now.` : "You approved this request.";
  if (!isRequester.value && r.status === "ready") return `All approvals are in. Only ${r.requester.name} can finish.`;
  return null;
});
const verb = computed(() => (req.value?.operation === "seal" ? "seal it" : "unlock it"));

async function load() {
  error.value = null;
  try {
    const out = await api.request(props.id);
    req.value = out.request;
    key.value = out.key;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function run(fn: () => Promise<void>) {
  error.value = null;
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError && ["EXPIRED", "CLOSED", "ALREADY_READY", "DUPLICATE_APPROVAL", "NOT_READY"].includes(e.code)) await load();
  } finally {
    step.value = null;
  }
}

// No awaits before Tide's window opens: the request bytes are already loaded.
const approve = () => run(async () => { req.value = await approveFlow(deps, req.value!, (s) => (step.value = s)); });
const finish = () => run(async () => {
  const out = await finishFlow(deps, req.value!, (s) => (step.value = s));
  req.value = out.request;
  key.value = out.key;
  secret.value = out.secret ?? null;
});
const reject = () => run(async () => { req.value = await api.reject(props.id, reason.value); rejecting.value = false; });
const cancel = () => run(async () => { req.value = await api.cancel(props.id); });

onMounted(load);
</script>

<template>
  <SkeletonRows v-if="!req && !error" :rows="2" />
  <Banner v-else-if="!req" tone="rejected">{{ error }}</Banner>
  <div v-else class="sheet stack">
    <RouterLink :to="`/vault/${req.keyId}`" class="small">← {{ req.keyName }}</RouterLink>
    <div class="spread">
      <h1 style="margin: 0">{{ OPERATION_LABEL[req.operation] }}: {{ req.keyName }}</h1>
      <StatusBadge :tone="REQUEST_STATUS[req.status].tone" :label="REQUEST_STATUS[req.status].label" />
    </div>
    <div class="row"><LevelBadge :level="req.keyLevel" :quorum="req.quorum" /><QuorumProgress :request="req" /></div>

    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <Banner v-if="req.rejection" tone="rejected">{{ req.rejection.name }} rejected: "{{ req.rejection.reason }}"</Banner>
    <Banner v-if="req.status === 'completed' && req.operation === 'seal'" tone="approved">Sealed. The key is in the vault; unlocking it needs {{ req.quorum }} board member{{ req.quorum === 1 ? "" : "s" }} every time.</Banner>
    <Banner v-if="req.status === 'completed' && req.operation === 'release' && !secret" tone="approved">{{ req.closedReason }} {{ formatTime(req.closedAt) }}. Each unlock needs a new request.</Banner>

    <SecretReveal v-if="secret" :secret="secret" @hide="secret = null" />

    <section class="card">
      <dl class="fields">
        <dt>Asked by</dt><dd>{{ req.requester.name }} · {{ timeAgo(req.createdAt) }}</dd>
        <dt>{{ req.operation === "release" ? "Why" : "What for" }}</dt><dd>{{ req.reason }}</dd>
        <template v-if="key">
          <dt>Type</dt><dd>{{ kindLabel(session.config?.kinds, key.kind) }}{{ key.provider ? ` · ${key.provider}` : "" }}</dd>
          <dt v-if="key.hint">Hint</dt><dd v-if="key.hint" class="mono">{{ key.hint }}</dd>
        </template>
        <dt>Open until</dt><dd>{{ formatTime(req.expiresAt) }}</dd>
      </dl>
    </section>

    <section class="card">
      <div class="spread"><h2 style="margin: 0">Approvals</h2><QuorumProgress :request="req" /></div>
      <ul class="approvals">
        <li v-for="a in req.approvals" :key="a.memberId">✓ {{ a.name }} <span class="muted small">signed in Tide{{ a.dokenVerified ? " · verified" : "" }} · {{ timeAgo(a.at) }}</span></li>
        <li v-for="i in remaining" :key="`o${i}`" class="muted">○ waiting for another board member</li>
        <li :class="{ muted: req.status !== 'completed' }">{{ req.status === "completed" ? "✓" : "○" }} {{ req.requester.name }} <span class="small">(requester, approves last when finishing)</span></li>
      </ul>
    </section>

    <Banner v-if="whyNot" tone="neutral">{{ whyNot }}</Banner>
    <p v-if="step" class="muted" role="status" aria-live="polite">{{ STEP_TEXT[step] }}</p>

    <form v-if="rejecting" class="card stack" @submit.prevent="reject">
      <label for="reason">Why are you rejecting?</label>
      <textarea id="reason" v-model="reason" required placeholder="e.g. No ticket for this, ask again with a reason" />
      <div class="row"><button type="button" class="btn" @click="rejecting = false">Cancel</button><button type="submit" class="btn btn-reject" :disabled="!reason.trim()">Reject</button></div>
    </form>

    <div v-if="open && canFinish" class="stack">
      <button class="btn btn-approve btn-block" :disabled="!!step" @click="finish">Approve in Tide and {{ verb }} ✓</button>
      <p class="muted small" style="text-align: center">Tide's window asks for your approval. The Tide network then checks all {{ req.quorum }} approvals before it {{ req.operation === "seal" ? "seals the key" : "decrypts the key, to this browser only" }}.</p>
    </div>
    <div v-else-if="open && canApprove" class="sticky-actions">
      <button class="btn btn-reject" :disabled="!!step || rejecting" @click="rejecting = true">Reject</button>
      <button class="btn btn-approve" :disabled="!!step" @click="approve">Approve ✓</button>
    </div>
    <div v-if="open && isRequester" class="row"><button class="btn" :disabled="!!step" @click="cancel">Cancel this request</button></div>
    <p v-if="open && canApprove" class="muted small" style="text-align: center">Approving opens Tide to confirm it's really you. The Tide network counts every approval again before it {{ req.operation === "seal" ? "seals" : "unlocks" }} anything.</p>
  </div>
</template>

<style scoped>
.sheet { max-width: 620px; margin: 0 auto; }
.approvals { list-style: none; padding: 0; margin: 0.5rem 0 0; display: grid; gap: 0.35rem; }
</style>
