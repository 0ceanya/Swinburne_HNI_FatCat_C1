<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/api/client";
import type { Doc, SigningRequest } from "@/api/types";
import ApprovalProgress from "@/components/ApprovalProgress.vue";
import Banner from "@/components/Banner.vue";
import HashChip from "@/components/HashChip.vue";
import SealedValue from "@/components/SealedValue.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { openRequest } from "@/flows/signing";
import { DOC_STATUS, DOC_TYPE_EN, DOC_TYPE_LABEL, formatTime, formatVnd, REQUEST_STATUS, shortHash, TIER_LABEL } from "@/lib/format";
import { useSealed } from "@/stores/sealed";
import { useSession } from "@/stores/session";
import * as tide from "@/tide/tide";

const props = defineProps<{ id: string }>();
const router = useRouter();
const session = useSession();
const sealed = useSealed();
const doc = ref<Doc | null>(null);
const requests = ref<SigningRequest[]>([]);
const error = ref<string | null>(null);
const busy = ref<string | null>(null);

const current = computed(() => requests.value.find((r) => r.id === doc.value?.currentRequestId) ?? null);
const isMine = computed(() => doc.value?.createdBy.id === session.me?.id);

/** The timeline is built from the requests' own records: every step carries who and when. */
const timeline = computed(() => {
  if (!doc.value) return [];
  const items: { at: string; text: string; tone: string }[] = [{ at: doc.value.createdAt, text: `${doc.value.createdBy.name} created the draft`, tone: "neutral" }];
  for (const r of [...requests.value].reverse()) {
    items.push({ at: r.createdAt, text: `${r.initiator.name} submitted (hash ${shortHash(r.contentHash)}, rule "${r.requirement.label}")`, tone: "pending" });
    for (const a of r.approvals) items.push({ at: a.at, text: `${a.name} approved as ${TIER_LABEL[a.countedAs]}${a.proof.kind === "tide-enclave" ? " in Tide" : ""}`, tone: "approved" });
    if (r.rejection) items.push({ at: r.rejection.at, text: `${r.rejection.name} rejected: "${r.rejection.reason}"`, tone: "rejected" });
    if (r.status === "signed") items.push({ at: r.closedAt ?? r.createdAt, text: "The Tide network signed the approval statement", tone: "approved" });
    if (r.status === "expired" || r.status === "cancelled") items.push({ at: r.closedAt ?? r.createdAt, text: `Request ${r.status}${r.closedReason ? `: ${r.closedReason}` : ""}`, tone: "neutral" });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
});

async function load() {
  try {
    const out = await api.document(props.id);
    doc.value = out.document;
    requests.value = out.requests;
    void sealed.open([out.document], !!session.me?.canDecrypt);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function act(label: string, fn: () => Promise<unknown>) {
  error.value = null;
  busy.value = label;
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

const submit = () => act("Submitting and opening the request on Tide…", async () => {
  const { request } = await api.submit(props.id);
  const opened = await openRequest({ tide, api }, request);
  if (opened.requirement.initiatorMayApprove) await router.push(`/approve/${opened.id}`);
});
const reopen = () => act("Opening the request on Tide…", async () => { if (current.value) await openRequest({ tide, api }, current.value); });
const withdraw = () => act("Withdrawing…", () => api.withdraw(props.id));

onMounted(load);
</script>

<template>
  <SkeletonRows v-if="!doc && !error" :rows="2" />
  <Banner v-else-if="!doc" tone="rejected">{{ error }}</Banner>
  <div v-else class="stack">
    <div class="spread">
      <h1>{{ DOC_TYPE_LABEL[doc.type] }} #{{ doc.number }}</h1>
      <StatusBadge :tone="DOC_STATUS[doc.status].tone" :label="DOC_STATUS[doc.status].label" />
    </div>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <Banner v-if="doc.sealing === 'plaintext-dev'" tone="rejected">This document's sensitive fields are stored unencrypted (development mode).</Banner>
    <Banner v-if="current && current.mode === 'tide' && !current.tideRequest" tone="pending">
      This request is not open on the Tide network yet, so approvers cannot sign it.
      <button class="btn" style="margin-left: 0.5rem" :disabled="!!busy" @click="reopen">Open on Tide</button>
    </Banner>

    <div class="grid-2">
      <section class="card">
        <h2>{{ doc.title }}</h2>
        <dl class="fields">
          <dt>Amount</dt><dd class="num"><strong>{{ formatVnd(doc.amountDong) }}</strong></dd>
          <dt>Type</dt><dd>{{ DOC_TYPE_EN[doc.type] }}</dd>
          <dt>Group</dt><dd>{{ doc.resourceGroupId }}</dd>
          <dt>Payee</dt><dd><SealedValue v-bind="sealed.fieldView(doc, 'counterparty')" :plaintext-dev="doc.sealing === 'plaintext-dev'" /></dd>
          <dt>Bank</dt><dd><SealedValue v-bind="sealed.fieldView(doc, 'bankAccount')" :plaintext-dev="doc.sealing === 'plaintext-dev'" /></dd>
          <dt>Description</dt><dd><SealedValue v-bind="sealed.fieldView(doc, 'description')" :plaintext-dev="doc.sealing === 'plaintext-dev'" /></dd>
          <dt>Hash</dt><dd><HashChip :hash="doc.contentHash" /></dd>
          <dt>Created by</dt><dd>{{ doc.createdBy.name }}, {{ formatTime(doc.createdAt) }}</dd>
          <template v-if="current">
            <dt>Rule</dt><dd>v{{ current.requirement.policyVersion }} · {{ current.requirement.label }}</dd>
            <dt>Approvals</dt><dd><ApprovalProgress :request="current" /> <span class="muted small">{{ REQUEST_STATUS[current.status].label }}</span></dd>
          </template>
        </dl>
        <div class="row" style="margin-top: 1rem">
          <template v-if="session.has('drafter')">
            <RouterLink v-if="doc.status !== 'signed'" :to="`/documents/${doc.id}/edit`" class="btn">Edit</RouterLink>
            <button v-if="doc.status === 'draft'" class="btn btn-primary" :disabled="!!busy" @click="submit">Submit for approval</button>
            <button v-if="doc.status === 'pending_approval' && isMine" class="btn btn-reject" :disabled="!!busy" @click="withdraw">Withdraw</button>
          </template>
          <RouterLink v-if="current && current.status !== 'signed'" :to="`/approve/${current.id}`" class="btn">Open approve sheet</RouterLink>
        </div>
        <p v-if="busy" class="muted small" role="status">{{ busy }}</p>
      </section>

      <aside class="stack">
        <section class="card">
          <h2>Timeline</h2>
          <ol class="timeline">
            <li v-for="(t, i) in timeline" :key="i" :data-tone="t.tone"><span class="muted small">{{ formatTime(t.at) }}</span><br />{{ t.text }}</li>
          </ol>
        </section>
        <section class="card">
          <h2>Signature receipt</h2>
          <p v-if="doc.receipts.length === 0" class="muted">Not signed yet.</p>
          <ul v-else class="receipts">
            <li v-for="r in doc.receipts" :key="r.provider + r.signedAt">
              <StatusBadge :tone="r.provider === 'dev-unsigned' ? 'rejected' : 'approved'" :label="r.provider === 'tide' ? 'Tide network (verified)' : r.provider === 'mock-ca' ? 'Mock CA' : 'NOT network-signed (dev)'" />
              <div class="muted small">{{ formatTime(r.signedAt) }} · covers {{ r.covers }}</div>
              <HashChip v-if="r.signature" :hash="r.signature" />
            </li>
          </ul>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { border-left: 3px solid var(--border); padding: 0.25rem 0 0.75rem 0.75rem; }
.timeline li[data-tone="approved"] { border-color: var(--approved); }
.timeline li[data-tone="pending"] { border-color: var(--pending); }
.timeline li[data-tone="rejected"] { border-color: var(--rejected); }
.receipts { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
</style>
