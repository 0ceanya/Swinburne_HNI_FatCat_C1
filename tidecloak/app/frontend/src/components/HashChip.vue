<script setup lang="ts">
import { ref } from "vue";
import { shortHash } from "@/lib/format";

const props = defineProps<{ hash: string | null }>();
const full = ref(false);
const copied = ref(false);

async function copy() {
  if (!props.hash) return;
  try {
    await navigator.clipboard.writeText(props.hash);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    full.value = true;
  }
}
</script>

<template>
  <span class="hash">
    <button type="button" class="link mono" :title="hash ?? ''" @click="full = !full">{{ full ? hash : shortHash(hash) }}</button>
    <button v-if="hash" type="button" class="link" :aria-label="copied ? 'Copied' : 'Copy full hash'" @click="copy">{{ copied ? "✓" : "⧉" }}</button>
  </span>
</template>

<style scoped>
.hash { display: inline-flex; gap: 0.35rem; align-items: center; flex-wrap: wrap; word-break: break-all; }
.link { background: none; border: none; color: inherit; font: inherit; padding: 0.2rem; cursor: pointer; min-height: 32px; }
</style>
