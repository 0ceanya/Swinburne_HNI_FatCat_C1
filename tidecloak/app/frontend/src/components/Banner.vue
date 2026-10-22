<script setup lang="ts">
defineProps<{ tone?: "neutral" | "pending" | "approved" | "rejected" }>();
</script>

<template>
  <div class="banner" :class="`tone-${tone ?? 'neutral'}`" :role="tone === 'rejected' ? 'alert' : 'status'"><slot /></div>
</template>
