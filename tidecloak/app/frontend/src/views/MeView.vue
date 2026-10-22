<script setup lang="ts">
import { tierNames } from "@/lib/format";
import { useSession } from "@/stores/session";

const session = useSession();
</script>

<template>
  <div class="stack">
    <h1>{{ session.me?.displayName }}</h1>
    <section class="card">
      <dl class="fields">
        <dt>Name</dt><dd>{{ session.me?.lastName }} {{ session.me?.firstName }}</dd>
        <dt>Roles</dt><dd>{{ tierNames(session.tiers) || "none" }}</dd>
        <dt>Board</dt><dd>{{ session.onBoard ? "On the board: your approval counts on the Tide network" : "Not on the board" }}</dd>
        <dt>Realm admin</dt><dd>{{ session.me?.isRealmAdmin ? "Yes: you can sign the vault policies in Tide setup" : "No" }}</dd>
        <dt>Tide id</dt><dd class="mono small" style="word-break: break-all">{{ session.me?.vuid }}</dd>
        <dt>Organisation</dt><dd>{{ session.config?.org.name }} · MST {{ session.config?.org.taxCode }}</dd>
      </dl>
    </section>
    <button class="btn" @click="session.logout()">Sign out</button>
  </div>
</template>
