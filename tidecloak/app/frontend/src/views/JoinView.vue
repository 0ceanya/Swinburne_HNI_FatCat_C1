<script setup lang="ts">
import { reactive, ref } from "vue";
import { api } from "@/api/client";
import type { Tier } from "@/api/types";
import Banner from "@/components/Banner.vue";
import { formatTime, TIER_LABEL } from "@/lib/format";
import { useSession } from "@/stores/session";

// Signed in with Tide, but not a member yet: show where the join request stands, or file one.
const session = useSession();
const form = reactive({ requestedTier: "drafter" as Tier, note: "" });
const error = ref<string | null>(null);
const busy = ref(false);

async function send() {
  busy.value = true;
  error.value = null;
  try {
    session.join = await api.fileJoinRequest({ ...form, name: session.me?.displayName });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function refresh() {
  await session.loadMe();
  await session.loadJoin();
}
</script>

<template>
  <main class="page stack" style="max-width: 560px">
    <div class="row"><img src="/favicon.png" alt="" width="40" height="40" style="border-radius: 50%" /><h1 style="margin: 0">Welcome, {{ session.me?.displayName }}</h1></div>
    <p class="muted">Your Tide account is ready. {{ session.config?.org.name }} decides what you can do in SignGuard.</p>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>

    <section v-if="session.join?.status === 'pending'" class="card stack">
      <h2>Waiting for the owner</h2>
      <p>You asked to join as <strong>{{ TIER_LABEL[session.join.requestedTier] }}</strong> on {{ formatTime(session.join.createdAt) }}.</p>
      <p class="muted small">The owner approves your role in Tide's window. Then you can start: sign out and back in, or press "Check again".</p>
      <div class="row"><button class="btn" @click="refresh">Check again</button><button class="btn" @click="session.logout()">Sign out</button></div>
    </section>

    <section v-else-if="session.join?.status === 'approved'" class="card stack">
      <h2>Approved</h2>
      <p>{{ session.join.decidedBy?.name }} approved you as {{ TIER_LABEL[session.join.requestedTier] }}. Your role becomes active once each change is approved in Tide; sign out and back in to pick it up.</p>
      <div class="row"><button class="btn btn-primary" @click="session.logout()">Sign out and back in</button><button class="btn" @click="refresh">Check again</button></div>
    </section>

    <form v-else class="card stack" @submit.prevent="send">
      <h2>{{ session.join?.status === "rejected" ? "Your request was declined" : "Ask to join" }}</h2>
      <p v-if="session.join?.status === 'rejected'" class="muted small">{{ session.join.decisionNote || "No reason given." }} You can ask again.</p>
      <div class="field">
        <label for="jv-tier">Role</label>
        <select id="jv-tier" v-model="form.requestedTier">
          <option value="drafter">Accountant / drafter</option><option value="approver">Approver</option>
          <option value="director">Director</option><option value="viewer">Viewer</option>
        </select>
      </div>
      <div class="field"><label for="jv-note">Note to the owner</label><textarea id="jv-note" v-model="form.note" /></div>
      <button class="btn btn-primary" :disabled="busy">Send request</button>
    </form>
  </main>
</template>
