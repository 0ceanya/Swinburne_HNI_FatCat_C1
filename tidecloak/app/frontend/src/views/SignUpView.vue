<script setup lang="ts">
import { ref } from "vue";
import { useSession } from "@/stores/session";

const session = useSession();
const handoff = ref(false);

function continueToTide() {
  handoff.value = true;
  void session.login("/");
}
</script>

<template>
  <main class="auth-page">
    <div class="card panel stack">
      <div class="row"><img src="/favicon.png" alt="" width="40" height="40" style="border-radius: 50%" /><h1 style="margin: 0">Create a Tide account</h1></div>
      <p class="muted small" style="margin: 0">{{ session.config?.org.name ?? "" }}</p>
      <p>Your SignGuard sign-in is a Tide account: a key and password that only Tide's network can check. Next, Tide's window opens: choose <strong>Create an account</strong> and pick a username and password. The password goes to Tide's network, never to SignGuard.</p>
      <p class="small muted">The board that approves keys is fixed. A new account can sign in, but cannot see or approve keys unless it is on the board.</p>
      <button class="btn btn-primary btn-block" :disabled="handoff" @click="continueToTide">{{ handoff ? "Opening Tide…" : "Continue to Tide" }}</button>
      <p class="small" style="margin: 0">Already have an account? <RouterLink to="/">Sign in</RouterLink></p>
    </div>
  </main>
</template>

<style scoped>
.auth-page { min-height: 100vh; display: grid; place-items: center; padding: 1rem; }
.panel { width: min(30rem, 100%); }
</style>
