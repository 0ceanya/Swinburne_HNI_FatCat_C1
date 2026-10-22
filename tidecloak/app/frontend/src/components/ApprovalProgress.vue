<script setup lang="ts">
import { computed } from "vue";
import type { SigningRequest } from "@/api/types";

const props = defineProps<{ request: Pick<SigningRequest, "approvals" | "totalRequired" | "requirement">; compact?: boolean }>();

// The drafter's submission counts as their part; approvals must come from other people, so
// "2 of 3" = submission + one approval (except the low band, where the drafter signs alone).
const total = computed(() => props.request.totalRequired + (props.request.requirement.initiatorMayApprove ? 0 : 1));
const done = computed(() => props.request.approvals.length + (props.request.requirement.initiatorMayApprove ? 0 : 1));
const label = computed(() => `${done.value} of ${total.value}`);
</script>

<template>
  <span class="progress" :aria-label="`Approvals: ${label}`">
    <span class="dots" aria-hidden="true">
      <span v-for="i in total" :key="i" class="dot" :class="{ on: i <= done }" />
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
