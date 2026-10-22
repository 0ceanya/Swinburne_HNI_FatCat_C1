<script setup lang="ts">
withDefaults(defineProps<{ rows?: number }>(), { rows: 3 });
</script>

<template>
  <div class="stack" aria-busy="true" aria-label="Loading">
    <div v-for="i in rows" :key="i" class="card"><div class="skeleton" style="width: 60%" /><div class="skeleton" style="width: 35%; margin-top: 0.5rem" /></div>
  </div>
</template>
