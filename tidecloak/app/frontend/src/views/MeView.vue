<script setup lang="ts">
import { ref } from "vue";
import ProfileOnboarding from "@/components/ProfileOnboarding.vue";
import { tierNames } from "@/lib/format";
import { useSession } from "@/stores/session";

const session = useSession();
const editing = ref(false);

function reopen() {
  try { localStorage.removeItem("signguard.profile-onboarding.dismissed"); } catch { /* private mode */ }
  editing.value = true;
}
</script>

<template>
  <div class="stack">
    <h1>{{ session.me?.displayName }}</h1>
    <section class="card">
      <dl class="fields">
        <dt>Name</dt><dd>{{ session.me?.lastName }} {{ session.me?.firstName }} <button class="btn" style="margin-left: 0.5rem" @click="reopen">Edit</button></dd>
        <dt>Tiers</dt><dd>{{ tierNames(session.tiers) || "none yet" }}</dd>
        <dt>Sealed fields</dt><dd>{{ session.me?.canDecrypt ? "Can read" : "Cannot read" }}{{ session.me?.canEncrypt ? " · can write" : "" }}</dd>
        <dt>Realm admin</dt><dd>{{ session.me?.isRealmAdmin ? "Yes" : "No" }}</dd>
        <dt>Tide id</dt><dd class="mono small" style="word-break: break-all">{{ session.me?.vuid }}</dd>
        <dt>Organisation</dt><dd>{{ session.config?.org.name }} · MST {{ session.config?.org.taxCode }}</dd>
      </dl>
    </section>
    <p class="muted small">Tier changes take effect after a realm admin approves them and you sign in again.</p>
    <button class="btn" @click="session.logout()">Sign out</button>
    <ProfileOnboarding v-if="editing" :first-name="session.me?.firstName" :last-name="session.me?.lastName" @done="(saved) => { editing = false; if (saved) session.loadMe(); }" />
  </div>
</template>
