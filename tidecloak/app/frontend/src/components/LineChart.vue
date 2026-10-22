<script setup lang="ts">
/**
 * Multi-series line chart: 2px lines, one shared y-axis, a legend plus direct labels at the line
 * ends, a crosshair with a tooltip on hover or arrow keys, and a table view of the same numbers.
 * Colours come from --series-N on an ancestor (validated in light and dark).
 */
import { computed, onMounted, onUnmounted, ref } from "vue";

export interface Series {
  name: string;
  /** CSS variable holding the series colour, e.g. "var(--series-1)". */
  color: string;
  values: number[];
}

const props = defineProps<{ labels: string[]; series: Series[]; title: string; formatLabel?: (s: string) => string }>();

const wrap = ref<HTMLElement | null>(null);
const width = ref(640);
const height = 220;
const pad = { top: 12, right: 118, bottom: 26, left: 32 };
const hover = ref<number | null>(null);
const asTable = ref(false);
let observer: ResizeObserver | null = null;

onMounted(() => {
  if (!wrap.value) return;
  width.value = wrap.value.clientWidth || 640;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(([e]) => { if (e) width.value = Math.max(320, e.contentRect.width); });
    observer.observe(wrap.value);
  }
});
onUnmounted(() => observer?.disconnect());

const fmt = (s: string) => props.formatLabel?.(s) ?? s;
const max = computed(() => {
  const m = Math.max(1, ...props.series.flatMap((s) => s.values));
  const step = m <= 5 ? 1 : m <= 10 ? 2 : 5;
  return Math.ceil(m / step) * step;
});
const ticks = computed(() => {
  const step = max.value <= 5 ? 1 : max.value <= 10 ? 2 : 5;
  return Array.from({ length: max.value / step + 1 }, (_, i) => i * step);
});
const plotW = computed(() => width.value - pad.left - pad.right);
const plotH = height - pad.top - pad.bottom;
const x = (i: number) => pad.left + (props.labels.length <= 1 ? 0 : (i / (props.labels.length - 1)) * plotW.value);
const y = (v: number) => pad.top + plotH - (v / max.value) * plotH;
const path = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

/** End labels nudged apart so they never overlap. */
const endLabels = computed(() => {
  const items = props.series.map((s) => ({ name: s.name, color: s.color, value: s.values.at(-1) ?? 0, y: y(s.values.at(-1) ?? 0) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < items.length; i++) if (items[i]!.y - items[i - 1]!.y < 14) items[i]!.y = items[i - 1]!.y + 14;
  return items;
});
const xTicks = computed(() => {
  const n = props.labels.length;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW.value / 70))));
  return props.labels.map((l, i) => ({ l, i })).filter(({ i }) => i % every === 0 || i === n - 1);
});

function onMove(e: MouseEvent) {
  const box = (e.currentTarget as SVGElement).getBoundingClientRect();
  const px = ((e.clientX - box.left) / box.width) * width.value;
  const i = Math.round(((px - pad.left) / plotW.value) * (props.labels.length - 1));
  hover.value = Math.max(0, Math.min(props.labels.length - 1, i));
}
function onKey(e: KeyboardEvent) {
  const last = props.labels.length - 1;
  if (e.key === "ArrowRight") hover.value = Math.min(last, (hover.value ?? -1) + 1);
  else if (e.key === "ArrowLeft") hover.value = Math.max(0, (hover.value ?? last + 1) - 1);
  else if (e.key === "Escape") hover.value = null;
  else return;
  e.preventDefault();
}
const tipLeft = computed(() => (hover.value === null ? 0 : Math.min(x(hover.value) + 12, width.value - 170)));
</script>

<template>
  <figure class="chart" :aria-label="title">
    <div class="spread chart-head">
      <ul class="legend" aria-label="Legend">
        <li v-for="s in series" :key="s.name"><span class="key" :style="{ background: s.color }" />{{ s.name }}</li>
      </ul>
      <button type="button" class="btn btn-small" @click="asTable = !asTable">{{ asTable ? "Show chart" : "Show as table" }}</button>
    </div>

    <div v-show="!asTable" ref="wrap" class="plot">
      <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="`${title}. Use the left and right arrow keys to read each day.`"
           tabindex="0" @mousemove="onMove" @mouseleave="hover = null" @keydown="onKey" @blur="hover = null">
        <g class="grid">
          <line v-for="t in ticks" :key="t" :x1="pad.left" :x2="pad.left + plotW" :y1="y(t)" :y2="y(t)" />
        </g>
        <g class="axis">
          <text v-for="t in ticks" :key="`y${t}`" :x="pad.left - 8" :y="y(t) + 4" text-anchor="end">{{ t }}</text>
          <text v-for="t in xTicks" :key="`x${t.i}`" :x="x(t.i)" :y="height - 6" :text-anchor="t.i === 0 ? 'start' : t.i === labels.length - 1 ? 'end' : 'middle'">{{ fmt(t.l) }}</text>
        </g>
        <line v-if="hover !== null" class="crosshair" :x1="x(hover)" :x2="x(hover)" :y1="pad.top" :y2="pad.top + plotH" />
        <path v-for="s in series" :key="s.name" :d="path(s.values)" :stroke="s.color" class="line" />
        <g v-for="s in series" :key="`end${s.name}`">
          <circle :cx="x(s.values.length - 1)" :cy="y(s.values.at(-1) ?? 0)" r="4" :fill="s.color" class="dot" />
          <circle v-if="hover !== null" :cx="x(hover)" :cy="y(s.values[hover] ?? 0)" r="4" :fill="s.color" class="dot" />
        </g>
        <g class="end-labels">
          <text v-for="l in endLabels" :key="l.name" :x="pad.left + plotW + 10" :y="l.y + 4">{{ l.value }} {{ l.name.toLowerCase() }}</text>
        </g>
      </svg>
      <div v-if="hover !== null" class="tip" :style="{ left: `${tipLeft}px` }" role="status">
        <strong>{{ fmt(labels[hover]!) }}</strong>
        <div v-for="s in series" :key="s.name" class="tip-row"><span class="key" :style="{ background: s.color }" />{{ s.name }}<span class="num">{{ s.values[hover] }}</span></div>
      </div>
    </div>

    <div v-if="asTable" class="table-wrap">
      <table class="table">
        <thead><tr><th>Day</th><th v-for="s in series" :key="s.name" class="num" style="text-align: right">{{ s.name }}</th></tr></thead>
        <tbody>
          <tr v-for="(l, i) in labels" :key="l"><td>{{ fmt(l) }}</td><td v-for="s in series" :key="s.name" class="num" style="text-align: right">{{ s.values[i] }}</td></tr>
        </tbody>
      </table>
    </div>
  </figure>
</template>

<style scoped>
.chart { margin: 0; }
.chart-head { margin-bottom: 0.5rem; }
.legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; font-size: 0.875rem; color: var(--muted); }
.legend li { display: inline-flex; align-items: center; gap: 0.4rem; }
.key { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
.plot { position: relative; width: 100%; }
svg { display: block; max-width: 100%; overflow: visible; }
svg:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
.grid line { stroke: var(--border); stroke-width: 1; }
.axis text, .end-labels text { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.end-labels text { fill: var(--text); font-size: 12px; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.dot { stroke: var(--surface); stroke-width: 2; }
.crosshair { stroke: var(--muted); stroke-width: 1; }
.tip { position: absolute; top: 4px; min-width: 150px; padding: 0.5rem 0.65rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: var(--shadow); font-size: 0.8rem; pointer-events: none; }
.tip-row { display: flex; align-items: center; gap: 0.4rem; }
.tip-row .num { margin-left: auto; font-weight: 600; }
.btn-small { min-height: 32px; padding: 0.25rem 0.65rem; font-size: 0.8rem; }
</style>
