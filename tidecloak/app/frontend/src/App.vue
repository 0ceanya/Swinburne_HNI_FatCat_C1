<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import AppNav from "@/components/AppNav.vue";
import Banner from "@/components/Banner.vue";
import NotOnBoardView from "@/views/NotOnBoardView.vue";
import SignInView from "@/views/SignInView.vue";
import SignUpView from "@/views/SignUpView.vue";
import { useSession } from "@/stores/session";

const session = useSession();
const route = useRoute();
const isPublic = computed(() => route.meta.public === true);
</script>

<template>
  <div v-if="!session.ready" class="page"><p class="muted">Starting SignGuard…</p></div>
  <RouterView v-else-if="isPublic" />
  <template v-else-if="!session.authenticated">
    <SignUpView v-if="route.path === '/signup'" />
    <SignInView v-else />
  </template>
  <NotOnBoardView v-else-if="session.me && !session.onBoard" />
  <template v-else>
    <AppNav />
    <main class="page stack">
      <Banner v-if="session.error" tone="rejected">{{ session.error }}</Banner>
      <Banner v-if="session.popupBlocked" tone="pending">
        Your browser blocked the Tide window. Allow pop-ups for this site, then try again.
        <button class="btn" style="margin-left: 0.5rem" @click="session.popupBlocked = false">Dismiss</button>
      </Banner>
      <RouterView :key="route.fullPath" />
    </main>
  </template>
</template>
