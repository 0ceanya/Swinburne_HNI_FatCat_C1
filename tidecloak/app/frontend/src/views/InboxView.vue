<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { api } from "@/api/client";
import type { Doc, SigningRequest } from "@/api/types";
import ApprovalProgress from "@/components/ApprovalProgress.vue";
import Banner from "@/components/Banner.vue";
import EmptyState from "@/components/EmptyState.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import { compactVnd, DOC_TYPE_LABEL, formatVnd, timeAgo } from "@/lib/format";
import { useSession } from "@/stores/session";

const session = useSession();
const loading = ref(true);
const error = ref<string | null>(null);
const inbox = ref<{ waitingForMe: SigningRequest[]; readyToSign: SigningRequest[]; mine: SigningRequest[] }>({ waitingForMe: [], readyToSign: [], mine: [] });
const drafts = ref<Doc[]>([]);
const signed = ref<Doc[]>([]);

async function load() {
  if (!session.isMember) { loading.value = false; return; }
  try {
    const [box, myDrafts, recent] = await Promise.all([api.inbox(), api.documents({ status: "draft" }), api.documents({ status: "signed" })]);
    inbox.value = box;
    drafts.value = myDrafts.filter((d) => d.createdBy.id === session.me?.id);
    signed.value = recent.slice(0, 5);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 8000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="stack">
    <div class="spread">
      <h1>Inbox</h1>
      <RouterLink v-if="session.has('drafter')" to="/documents/new" class="btn btn-primary">+ New document</RouterLink>
    </div>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <SkeletonRows v-if="loading" />
    <template v-else-if="session.isMember">
      <section class="stack">
        <h2>Waiting for you ({{ inbox.waitingForMe.length }})</h2>
        <EmptyState v-if="inbox.waitingForMe.length === 0" title="Nothing waiting for you">New approval requests for your tier will appear here.</EmptyState>
        <RouterLink v-for="r in inbox.waitingForMe" :key="r.id" :to="`/approve/${r.id}`" class="card card-link">
          <div class="spread"><strong>{{ DOC_TYPE_LABEL[r.documentType] }} #{{ r.documentNumber }}</strong><ApprovalProgress :request="r" /></div>
          <div class="spread"><span class="num" style="font-size: 1.15rem; font-weight: 600">{{ formatVnd(r.amountDong) }}</span><span class="muted small">{{ r.requirement.label }}</span></div>
          <div class="muted small">from {{ r.initiator.name }} · {{ timeAgo(r.createdAt) }}</div>
        </RouterLink>
      </section>

      <section v-if="inbox.readyToSign.length" class="stack">
        <h2>Approved, waiting for the network signature ({{ inbox.readyToSign.length }})</h2>
        <RouterLink v-for="r in inbox.readyToSign" :key="r.id" :to="`/approve/${r.id}`" class="card card-link">
          <div class="spread"><strong>{{ DOC_TYPE_LABEL[r.documentType] }} #{{ r.documentNumber }}</strong><span class="badge tone-pending">● Finish signing</span></div>
          <div class="num">{{ compactVnd(r.amountDong) }}</div>
        </RouterLink>
      </section>

      <section v-if="inbox.mine.length" class="stack">
        <h2>Your open requests ({{ inbox.mine.length }})</h2>
        <RouterLink v-for="r in inbox.mine" :key="r.id" :to="`/documents/${r.documentId}`" class="card card-link">
          <div class="spread"><strong>#{{ r.documentNumber }} · {{ formatVnd(r.amountDong) }}</strong><ApprovalProgress :request="r" /></div>
          <div class="muted small">Waiting for: {{ r.outstanding.join(", ") || "network signature" }}</div>
        </RouterLink>
      </section>

      <section v-if="drafts.length" class="stack">
        <h2>Your drafts ({{ drafts.length }})</h2>
        <RouterLink v-for="d in drafts" :key="d.id" :to="`/documents/${d.id}`" class="card card-link">
          <div class="spread"><strong>{{ DOC_TYPE_LABEL[d.type] }} #{{ d.number }} · {{ d.title }}</strong><span class="num">{{ compactVnd(d.amountDong) }}</span></div>
        </RouterLink>
      </section>

      <section v-if="signed.length" class="stack">
        <h2>Recently signed</h2>
        <RouterLink v-for="d in signed" :key="d.id" :to="`/documents/${d.id}`" class="card card-link">
          <div class="spread"><span>#{{ d.number }} · {{ d.title }}</span><span class="badge tone-approved">✓ Signed</span></div>
        </RouterLink>
      </section>
    </template>
  </div>
</template>
