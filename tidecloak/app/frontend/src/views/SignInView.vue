<script setup lang="ts">
import { useRoute } from "vue-router";
import { useSession } from "@/stores/session";

const session = useSession();
const route = useRoute();
</script>

<template>
  <main class="auth-page">
    <div class="card panel stack">
      <div class="row"><img src="/favicon.png" alt="" width="48" height="48" style="border-radius: 50%" /><h1 style="margin: 0">SignGuard</h1></div>
      <p class="muted small" style="margin: 0">{{ session.config?.org.name ?? "" }}</p>
      <h2>Sign in</h2>
      <p>The company's keys (digital signatures, cloud root keys, API keys) are locked by the Tide network. No one can unlock a key alone: the board approves, and the network checks every approval.</p>
      <p v-if="session.error" class="small" role="alert" style="color: var(--rejected)">{{ session.error }}</p>
      <button class="btn btn-primary btn-block" @click="session.login(route.fullPath === '/signup' ? '/' : route.fullPath)">Sign in with your Tide key</button>
      <p class="muted small">You type your password in Tide's own window. Tide's network checks it jointly; no server, including ours, ever sees it.</p>
      <hr class="sep" />
      <p style="margin: 0">New here? <RouterLink to="/signup">Create a Tide account</RouterLink></p>
    </div>
  </main>
</template>

<style scoped>
.auth-page { min-height: 100vh; display: grid; place-items: center; padding: 1rem; }
.panel { width: min(28rem, 100%); }
.sep { border: none; border-top: 1px solid var(--border); margin: 0.5rem 0; }
</style>
