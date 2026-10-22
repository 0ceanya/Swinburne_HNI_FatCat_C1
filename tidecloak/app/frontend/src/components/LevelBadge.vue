<script setup lang="ts">
import { computed } from "vue";
import type { Level } from "@/api/types";
import { LEVEL_LABEL, LEVEL_TONE } from "@/lib/format";

const props = defineProps<{ level: Level; quorum?: number }>();
const text = computed(() => `Level ${props.level} · ${LEVEL_LABEL[props.level]}${props.quorum ? ` · ${props.quorum} ${props.quorum === 1 ? "person" : "people"}` : ""}`);
</script>

<template>
  <span class="badge" :class="`tone-${LEVEL_TONE[level]}`"><span aria-hidden="true">🔑</span>{{ text }}</span>
</template>
