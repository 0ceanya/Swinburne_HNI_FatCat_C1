<script setup lang="ts">
defineProps<{ state: "open" | "locked" | "loading"; value?: string; reason?: string; plaintextDev?: boolean }>();
</script>

<template>
  <span v-if="state === 'loading'" class="skeleton" style="display: inline-block; width: 10rem" aria-label="Decrypting" />
  <span v-else-if="state === 'locked'" class="badge tone-sealed" :title="reason">🔒 Hidden: {{ reason ?? "no access" }}</span>
  <span v-else>
    <span class="sealed-mark" :title="plaintextDev ? 'Stored unencrypted (dev mode)' : 'Sealed by Tide, decrypted in your browser'">{{ plaintextDev ? "⚠" : "🔒" }}</span>
    {{ value || "—" }}
  </span>
</template>

<style scoped>
.sealed-mark { color: var(--sealed); margin-right: 0.25rem; }
</style>
