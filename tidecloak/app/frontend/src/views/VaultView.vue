<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "@/api/client";
import type { VaultKey } from "@/api/types";
import Banner from "@/components/Banner.vue";
import EmptyState from "@/components/EmptyState.vue";
import LevelBadge from "@/components/LevelBadge.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { formatTime, KEY_STATUS, kindLabel } from "@/lib/format";
import { useSession } from "@/stores/session";

const session = useSession();
const keys = ref<VaultKey[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const showRejected = ref(false);
const shown = computed(() => keys.value.filter((k) => showRejected.value || k.status !== "rejected"));

onMounted(async () => {
  try {
    keys.value = await api.keys();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="stack">
    <div class="spread">
      <h1>Vault</h1>
      <RouterLink to="/vault/new" class="btn btn-primary">+ Add a key</RouterLink>
    </div>
    <p class="muted">Third-party keys locked by the Tide network. Each key's level is how many board members must approve before anyone can see it.</p>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <SkeletonRows v-if="loading" />
    <EmptyState v-else-if="shown.length === 0" title="The vault is empty">Add a key: a Viettel MySign credential, a cloud root key, an API key.</EmptyState>
    <div v-else class="card table-wrap">
      <table class="table">
        <thead><tr><th>Key</th><th>Level</th><th>Status</th><th>Last unlocked</th></tr></thead>
        <tbody>
          <tr v-for="k in shown" :key="k.id">
            <td>
              <RouterLink :to="`/vault/${k.id}`"><strong>{{ k.name }}</strong></RouterLink>
              <div class="muted small">{{ kindLabel(session.config?.kinds, k.kind) }}{{ k.provider ? ` · ${k.provider}` : "" }}</div>
            </td>
            <td><LevelBadge :level="k.level" :quorum="k.quorum" /></td>
            <td><StatusBadge :tone="KEY_STATUS[k.status].tone" :label="KEY_STATUS[k.status].label" /></td>
            <td class="small">{{ k.lastReleasedAt ? `${formatTime(k.lastReleasedAt)} · ${k.lastReleasedTo?.name}` : "never" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <label class="small row" style="gap: 0.4rem; font-weight: 400"><input v-model="showRejected" type="checkbox" style="width: auto; min-height: auto" /> Show keys the board did not seal</label>
  </div>
</template>
