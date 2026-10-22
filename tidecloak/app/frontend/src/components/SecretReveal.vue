<script setup lang="ts">
/**
 * Shows an unlocked secret for a short time, in this browser only. It is never sent anywhere and is
 * dropped from memory when the panel closes or the timer runs out.
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { parseFileSecret } from "@/lib/format";

const props = withDefaults(defineProps<{ secret: string; seconds?: number }>(), { seconds: 60 });
const emit = defineEmits<{ hide: [] }>();

const shown = ref(false);
const copied = ref(false);
const left = ref(props.seconds);
const file = computed(() => parseFileSecret(props.secret));
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  timer = setInterval(() => {
    left.value -= 1;
    if (left.value <= 0) hide();
  }, 1000);
});
onUnmounted(() => clearInterval(timer));

function hide() {
  clearInterval(timer);
  emit("hide");
}

async function copy() {
  try {
    await navigator.clipboard.writeText(props.secret);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    shown.value = true;
  }
}

function download() {
  const f = file.value;
  if (!f) return;
  const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: f.mime }));
  const a = Object.assign(document.createElement("a"), { href: url, download: f.name });
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <section class="card reveal stack" aria-live="polite">
    <div class="spread">
      <h2 style="margin: 0">🔓 Unlocked for you</h2>
      <span class="muted small" role="timer">Hides in {{ left }} s</span>
    </div>
    <p class="muted small" style="margin: 0">Decrypted by the Tide network for this browser only, after the board approved. SignGuard's server never saw it.</p>
    <template v-if="file">
      <p style="margin: 0">File: <strong>{{ file.name }}</strong></p>
      <div class="row"><button class="btn btn-primary" @click="download">Download {{ file.name }}</button><button class="btn" @click="hide">Hide now</button></div>
    </template>
    <template v-else>
      <code class="secret" data-testid="secret">{{ shown ? secret : "•".repeat(Math.min(secret.length, 24)) }}</code>
      <div class="row">
        <button class="btn" @click="shown = !shown">{{ shown ? "Mask" : "Show" }}</button>
        <button class="btn btn-primary" @click="copy">{{ copied ? "Copied ✓" : "Copy" }}</button>
        <button class="btn" @click="hide">Hide now</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.reveal { border-color: var(--sealed); background: var(--sealed-bg); }
.secret { display: block; padding: 0.75rem; border-radius: var(--radius-sm); background: var(--surface); border: 1px solid var(--border); word-break: break-all; white-space: pre-wrap; }
</style>
