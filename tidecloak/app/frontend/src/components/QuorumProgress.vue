<script setup lang="ts">
import { computed } from "vue";
import type { KeyRequest } from "@/api/types";

const props = defineProps<{ request: Pick<KeyRequest, "quorum" | "approvals" | "status"> }>();

// The requester's approval is the last one: it is added in their browser when they finish.
const done = computed(() => props.request.approvals.length + (props.request.status === "completed" ? 1 : 0));
const label = computed(() => `${done.value} of ${props.request.quorum}`);
</script>

<template>
  <span class="progress" :aria-label="`Approvals: ${label}`">
    <span class="dots" aria-hidden="true">
      <span v-for="i in request.quorum" :key="i" class="dot" :class="{ on: i <= done }" />
    </span>
    <span class="num small">{{ label }}</span>
  </span>
</template>

<style scoped>
.progress { display: inline-flex; align-items: center; gap: 0.4rem; }
.dots { display: inline-flex; gap: 3px; }
.dot { width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--brand); }
.dot.on { background: var(--brand); }
</style>
