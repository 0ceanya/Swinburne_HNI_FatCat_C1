<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <div class="card empty">
    <p><strong>{{ title }}</strong></p>
    <p class="muted small"><slot /></p>
  </div>
</template>

<style scoped>
.empty { text-align: center; padding: 1.5rem 1rem; }
</style>
