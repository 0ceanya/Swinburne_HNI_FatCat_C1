<script setup lang="ts">
import { useSession } from "@/stores/session";

// Signed in with Tide, but not one of the board members whose approvals the network counts.
const session = useSession();
</script>

<template>
  <main class="page stack" style="max-width: 560px">
    <div class="row"><img src="/favicon.png" alt="" width="40" height="40" style="border-radius: 50%" /><h1 style="margin: 0">Welcome, {{ session.me?.displayName }}</h1></div>
    <section class="card stack">
      <h2>You are signed in, but not on the board</h2>
      <p>{{ session.config?.org.name }}'s vault is run by a fixed board of {{ session.config?.boardSize ?? 3 }}. Only board members can see keys, ask for them or approve requests.</p>
      <p class="muted small">Board seats and roles are managed in TideCloak, not in SignGuard.</p>
      <div class="row"><button class="btn" @click="session.loadMe()">Check again</button><button class="btn" @click="session.logout()">Sign out</button></div>
    </section>
  </main>
</template>
