<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, ApiError } from "@/api/client";
import type { Doc, SigningRequest } from "@/api/types";
import ApprovalProgress from "@/components/ApprovalProgress.vue";
import Banner from "@/components/Banner.vue";
import HashChip from "@/components/HashChip.vue";
import SealedValue from "@/components/SealedValue.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import { approveAndMaybeSign, finishSigning, openRequest, type Step } from "@/flows/signing";
import { DOC_TYPE_LABEL, formatVnd, REQUEST_STATUS, TIER_LABEL } from "@/lib/format";
import { useSealed } from "@/stores/sealed";
import { useSession } from "@/stores/session";
import * as tide from "@/tide/tide";

const props = defineProps<{ requestId: string }>();
const session = useSession();
const sealed = useSealed();

const req = ref<SigningRequest | null>(null);
const rule = ref<string | null>(null);
const doc = ref<Doc | null>(null);
const error = ref<string | null>(null);
const step = ref<Step | null>(null);
const rejecting = ref(false);
const reason = ref("");

const STEP_TEXT: Record<Step, string> = {
  opening: "Opening the request on the Tide network…",
  approving: "Confirm in the Tide window that just opened…",
  recording: "Recording your approval…",
  signing: "All approvals are in. The Tide network is checking them and signing…",
  done: "Done.",
};

const me = computed(() => session.me);
const isInitiator = computed(() => !!req.value && req.value.initiator.memberId === me.value?.id);
const alreadyApproved = computed(() => !!req.value?.approvals.some((a) => a.memberId === me.value?.id));
const open = computed(() => !!req.value && ["collecting", "quorum_met"].includes(req.value.status));
const tiersNeeded = computed(() => req.value?.outstanding ?? []);
const canApprove = computed(() => {
  const r = req.value;
  if (!r || r.status !== "collecting" || alreadyApproved.value) return false;
  if (isInitiator.value && !r.requirement.initiatorMayApprove) return false;
  return tiersNeeded.value.some((t) => session.tiers.includes(t));
});
const whyNot = computed(() => {
  const r = req.value;
  if (!r || !open.value) return null;
  if (alreadyApproved.value) return "You have approved this request.";
  if (isInitiator.value && !r.requirement.initiatorMayApprove) return "You submitted this document, so you cannot approve it. Someone else must.";
  if (r.status === "collecting" && !canApprove.value) return `This request needs: ${tiersNeeded.value.map((t) => TIER_LABEL[t]).join(", ")}.`;
  return null;
});

async function load() {
  error.value = null;
  try {
    const out = await api.request(props.requestId);
    req.value = out.request;
    rule.value = out.signingRule;
    const d = await api.document(out.request.documentId);
    doc.value = d.document;
    void sealed.open([d.document], !!session.me?.canDecrypt);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function run(fn: () => Promise<SigningRequest>) {
  error.value = null;
  try {
    req.value = await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError && ["STALE_REQUEST", "HASH_MISMATCH", "EXPIRED"].includes(e.code)) await load();
  } finally {
    step.value = null;
  }
}

// No awaits before the Tide window opens: the request bytes are already loaded.
const approve = () => run(() => approveAndMaybeSign({ tide, api }, req.value!, rule.value, (s) => (step.value = s)));
const finish = () => run(() => finishSigning({ tide, api }, req.value!, rule.value, (s) => (step.value = s)));
const openOnTide = () => run(async () => { step.value = "opening"; return openRequest({ tide, api }, req.value!); });
const reject = () => run(async () => {
  const r = await api.reject(props.requestId, reason.value);
  rejecting.value = false;
  return r;
});

onMounted(load);
</script>

<template>
  <SkeletonRows v-if="!req && !error" :rows="2" />
  <Banner v-else-if="!req" tone="rejected">{{ error }}</Banner>
  <div v-else class="sheet stack">
    <RouterLink :to="`/documents/${req.documentId}`" class="small">← {{ DOC_TYPE_LABEL[req.documentType] }} #{{ req.documentNumber }}</RouterLink>
    <div class="amount-hero">{{ formatVnd(req.amountDong) }}</div>
    <p class="muted small" style="text-align: center; margin: 0">Rule: {{ req.requirement.label }}</p>

    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <Banner v-if="req.mode === 'unsigned-dev'" tone="rejected">Development mode: this approval is NOT signed by the Tide network.</Banner>
    <Banner v-if="!open" :tone="REQUEST_STATUS[req.status].tone === 'approved' ? 'approved' : 'neutral'">
      {{ REQUEST_STATUS[req.status].label }}{{ req.rejection ? `: ${req.rejection.name}: "${req.rejection.reason}"` : "" }}
    </Banner>

    <section class="card">
      <dl class="fields">
        <dt>To</dt><dd><SealedValue v-if="doc" v-bind="sealed.fieldView(doc, 'counterparty')" :plaintext-dev="doc.sealing === 'plaintext-dev'" /></dd>
        <dt>Bank</dt><dd><SealedValue v-if="doc" v-bind="sealed.fieldView(doc, 'bankAccount')" :plaintext-dev="doc.sealing === 'plaintext-dev'" /></dd>
        <dt>Title</dt><dd>{{ doc?.title }}</dd>
        <dt>By</dt><dd>{{ req.initiator.name }} (drafter)</dd>
        <dt>Hash</dt><dd><HashChip :hash="req.contentHash" /></dd>
      </dl>
    </section>

    <section class="card">
      <div class="spread"><h2 style="margin: 0">Approvals</h2><ApprovalProgress :request="req" /></div>
      <ul class="approvals">
        <li v-if="!req.requirement.initiatorMayApprove">✓ {{ req.initiator.name }} <span class="muted small">submitted</span></li>
        <li v-for="a in req.approvals" :key="a.memberId">✓ {{ a.name }} <span class="muted small">{{ TIER_LABEL[a.countedAs] }}{{ a.proof.kind === "tide-enclave" ? " · signed in Tide" : "" }}</span></li>
        <li v-for="(t, i) in req.outstanding" :key="`o${i}`" class="muted">○ waiting for {{ TIER_LABEL[t] }}</li>
      </ul>
    </section>

    <Banner v-if="whyNot" tone="neutral">{{ whyNot }}</Banner>
    <Banner v-if="open && req.mode === 'tide' && !req.tideRequest" tone="pending">
      The drafter's browser has not opened this request on the Tide network yet.
      <button class="btn" style="margin-left: 0.5rem" :disabled="!!step" @click="openOnTide">Open it now</button>
    </Banner>
    <p v-if="step" class="muted" role="status" aria-live="polite">{{ STEP_TEXT[step] }}</p>

    <form v-if="rejecting" class="card stack" @submit.prevent="reject">
      <label for="reason">Why are you rejecting?</label>
      <textarea id="reason" v-model="reason" required placeholder="e.g. Unknown payee, no contract on file" />
      <div class="row"><button type="button" class="btn" @click="rejecting = false">Cancel</button><button type="submit" class="btn btn-reject" :disabled="!reason.trim()">Reject</button></div>
    </form>

    <div v-if="open" class="sticky-actions">
      <button class="btn btn-reject" :disabled="!!step || !canApprove || rejecting" @click="rejecting = true">Reject</button>
      <button v-if="req.status === 'quorum_met'" class="btn btn-approve" :disabled="!!step || !rule" @click="finish">Finish signing ✓</button>
      <button v-else class="btn btn-approve" :disabled="!!step || !canApprove || (req.mode === 'tide' && !req.tideRequest)" @click="approve">Approve ✓</button>
    </div>
    <p v-if="open && req.mode === 'tide'" class="muted small" style="text-align: center">Approving opens Tide to confirm it's really you. The Tide network checks every approval again before it signs.</p>
  </div>
</template>

<style scoped>
.sheet { max-width: 560px; margin: 0 auto; }
.approvals { list-style: none; padding: 0; margin: 0.5rem 0 0; display: grid; gap: 0.35rem; }
</style>
