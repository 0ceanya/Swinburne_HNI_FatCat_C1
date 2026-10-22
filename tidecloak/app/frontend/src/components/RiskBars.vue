<script setup lang="ts">
/**
 * One measure across items (risk score per key, 0-100): horizontal bars, sorted, value at the tip,
 * a "review" line at 70. Single series, so no legend: the section title names it.
 */
import { ref } from "vue";
import type { KeyRisk } from "@/lib/riskModel";

defineProps<{ items: KeyRisk[]; threshold?: number }>();
const hover = ref<string | null>(null);
</script>

<template>
  <div class="bars" role="list">
    <div v-for="k in items" :key="k.keyId" class="row" role="listitem" tabindex="0"
         :aria-label="`${k.name}: risk ${k.score} of 100. ${k.drivers.join(', ')}`"
         @mouseenter="hover = k.keyId" @mouseleave="hover = null" @focus="hover = k.keyId" @blur="hover = null">
      <div class="name" :title="k.name"><span class="truncate">{{ k.name }}</span><span class="muted small lvl">· L{{ k.level }}</span></div>
      <div class="track">
        <div class="bar" :style="{ width: `${Math.max(k.score, 2)}%` }" />
        <div class="threshold" :style="{ left: `${threshold ?? 70}%` }" aria-hidden="true" />
        <span class="value num" :style="{ left: `calc(${Math.max(k.score, 2)}% + 6px)` }">{{ k.score }}</span>
      </div>
      <div v-if="hover === k.keyId" class="tip" role="status">{{ k.drivers.join(" · ") }}</div>
    </div>
    <p class="muted small legend-note"><span class="tick" aria-hidden="true" /> review line at {{ threshold ?? 70 }}</p>
  </div>
</template>

<style scoped>
.bars { display: grid; gap: 0.6rem; }
.row { position: relative; display: grid; grid-template-columns: minmax(8rem, 13rem) 1fr; align-items: center; gap: 0.75rem; border-radius: var(--radius-sm); }
.row:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.name { display: flex; min-width: 0; font-size: 0.875rem; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.lvl { flex-shrink: 0; white-space: nowrap; margin-left: 0.3rem; }
.track { position: relative; height: 22px; margin-right: 2.5rem; }
.bar { position: absolute; top: 4px; left: 0; height: 14px; background: var(--series-1); border-radius: 0 4px 4px 0; }
.threshold { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--muted); }
.value { position: absolute; top: 2px; font-size: 0.8rem; font-weight: 600; color: var(--text); }
.tip { position: absolute; right: 0; top: -1.9rem; z-index: 2; padding: 0.3rem 0.55rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: var(--shadow); font-size: 0.78rem; white-space: nowrap; }
.legend-note { display: flex; align-items: center; gap: 0.4rem; margin: 0; }
.tick { display: inline-block; width: 1px; height: 12px; background: var(--muted); }
@media (max-width: 560px) { .row { grid-template-columns: 1fr; gap: 0.2rem; } }
</style>
