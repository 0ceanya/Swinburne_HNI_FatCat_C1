<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ tone: "neutral" | "pending" | "approved" | "rejected" | "sealed"; label: string }>();
// Status is never colour alone: every tone has its own icon too.
const icon = computed(() => ({ approved: "✓", pending: "●", rejected: "✕", sealed: "🔒", neutral: "○" })[props.tone]);
</script>

<template>
  <span class="badge" :class="`tone-${tone}`"><span aria-hidden="true">{{ icon }}</span>{{ label }}</span>
</template>
