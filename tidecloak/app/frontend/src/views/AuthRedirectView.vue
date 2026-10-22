<script setup lang="ts">
import { watch } from "vue";
import { useRouter } from "vue-router";
import { useSession } from "@/stores/session";

// The SDK completes the code exchange during init (main.ts). Once that settles, leave this page.
const session = useSession();
const router = useRouter();
watch(() => session.ready, (ready) => {
  if (!ready) return;
  const saved = sessionStorage.getItem("signguard.returnTo");
  sessionStorage.removeItem("signguard.returnTo");
  void router.replace(saved && saved.startsWith("/") && !saved.startsWith("//") ? saved : "/");
}, { immediate: true });
</script>

<template>
  <main class="page"><p class="muted">Completing sign-in…</p></main>
</template>
