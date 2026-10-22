<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { api, type Inbox } from "@/api/client";
import Banner from "@/components/Banner.vue";
import EmptyState from "@/components/EmptyState.vue";
import LevelBadge from "@/components/LevelBadge.vue";
import QuorumProgress from "@/components/QuorumProgress.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { OPERATION_LABEL, REQUEST_STATUS, timeAgo } from "@/lib/format";

const loading = ref(true);
const error = ref<string | null>(null);
const inbox = ref<Inbox>({ waitingForMe: [], readyToFinish: [], mine: [], recent: [] });

async function load() {
  try {
    inbox.value = await api.inbox();
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
      <RouterLink to="/vault/new" class="btn btn-primary">+ Add a key</RouterLink>
    </div>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <SkeletonRows v-if="loading" />
    <template v-else>
      <section class="stack">
        <h2>Waiting for your approval ({{ inbox.waitingForMe.length }})</h2>
        <EmptyState v-if="inbox.waitingForMe.length === 0" title="Nothing waiting for you">When a board member asks to seal or unlock a key, it appears here.</EmptyState>
        <RouterLink v-for="r in inbox.waitingForMe" :key="r.id" :to="`/requests/${r.id}`" class="card card-link">
          <div class="spread"><strong>{{ OPERATION_LABEL[r.operation] }}: {{ r.keyName }}</strong><QuorumProgress :request="r" /></div>
          <div class="spread"><LevelBadge :level="r.keyLevel" :quorum="r.quorum" /><span class="muted small">from {{ r.requester.name }} · {{ timeAgo(r.createdAt) }}</span></div>
          <div class="small">“{{ r.reason }}”</div>
        </RouterLink>
      </section>

      <section v-if="inbox.readyToFinish.length" class="stack">
        <h2>Approved: ready for you to finish ({{ inbox.readyToFinish.length }})</h2>
        <RouterLink v-for="r in inbox.readyToFinish" :key="r.id" :to="`/requests/${r.id}`" class="card card-link">
          <div class="spread"><strong>{{ OPERATION_LABEL[r.operation] }}: {{ r.keyName }}</strong><span class="badge tone-approved">✓ Finish now</span></div>
        </RouterLink>
      </section>

      <section v-if="inbox.mine.length" class="stack">
        <h2>Your open requests ({{ inbox.mine.length }})</h2>
        <RouterLink v-for="r in inbox.mine" :key="r.id" :to="`/requests/${r.id}`" class="card card-link">
          <div class="spread"><strong>{{ OPERATION_LABEL[r.operation] }}: {{ r.keyName }}</strong><QuorumProgress :request="r" /></div>
          <div class="muted small">{{ REQUEST_STATUS[r.status].label }}</div>
        </RouterLink>
      </section>

      <section v-if="inbox.recent.length" class="stack">
        <h2>Recent</h2>
        <RouterLink v-for="r in inbox.recent" :key="r.id" :to="`/requests/${r.id}`" class="card card-link">
          <div class="spread"><span>{{ OPERATION_LABEL[r.operation] }}: {{ r.keyName }} · {{ r.requester.name }}</span><StatusBadge :tone="REQUEST_STATUS[r.status].tone" :label="REQUEST_STATUS[r.status].label" /></div>
        </RouterLink>
      </section>
    </template>
  </div>
</template>
