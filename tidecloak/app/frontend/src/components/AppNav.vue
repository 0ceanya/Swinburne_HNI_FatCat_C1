<script setup lang="ts">
import { computed } from "vue";
import { useSession } from "@/stores/session";

const session = useSession();
// UI gating only: every one of these screens is enforced again by the server.
const links = computed(() => [
  { to: "/", label: "Inbox", icon: "📥", show: true },
  { to: "/documents", label: "Documents", icon: "📄", show: session.isMember },
  { to: "/policy", label: "Policy", icon: "⚖", show: session.isMember },
  { to: "/members", label: "Members", icon: "👥", show: session.has("owner", "director") },
  { to: "/audit", label: "Audit", icon: "🧾", show: session.has("owner", "director") },
  { to: "/setup", label: "Tide setup", icon: "🔑", show: !!session.me?.isRealmAdmin },
].filter((l) => l.show));
const mobileLinks = computed(() => [...links.value.filter((l) => ["/", "/documents", "/audit"].includes(l.to)), { to: "/me", label: "Me", icon: "👤", show: true }]);
</script>

<template>
  <header class="top">
    <div class="inner">
      <RouterLink to="/" class="brand"><img src="/favicon.png" alt="" width="28" height="28" /> SignGuard</RouterLink>
      <nav class="desktop" aria-label="Main">
        <RouterLink v-for="l in links" :key="l.to" :to="l.to" class="navlink">{{ l.label }}<span v-if="l.to === '/' && session.waitingCount" class="count" :aria-label="`${session.waitingCount} waiting for you`">{{ session.waitingCount }}</span></RouterLink>
      </nav>
      <RouterLink to="/me" class="me">{{ session.me?.displayName ?? "…" }}</RouterLink>
    </div>
  </header>
  <nav class="bottom" aria-label="Main">
    <RouterLink v-for="l in mobileLinks" :key="l.to" :to="l.to" class="tab"><span aria-hidden="true">{{ l.icon }}</span>{{ l.label }}<span v-if="l.to === '/' && session.waitingCount" class="count">{{ session.waitingCount }}</span></RouterLink>
  </nav>
</template>

<style scoped>
.top { background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 20; }
.inner { max-width: 1080px; margin: 0 auto; padding: 0.5rem 1rem; display: flex; align-items: center; gap: 1rem; }
.brand { display: flex; align-items: center; gap: 0.5rem; font-weight: 700; color: var(--text); text-decoration: none; }
.brand img { border-radius: 50%; }
.desktop { display: flex; gap: 0.25rem; flex: 1; }
.navlink { padding: 0.5rem 0.75rem; border-radius: var(--radius-sm); color: var(--muted); text-decoration: none; font-weight: 500; }
.navlink.router-link-exact-active, .navlink.router-link-active:not([href="/"]) { color: var(--brand); background: var(--surface-2); }
.me { margin-left: auto; color: var(--text); text-decoration: none; font-weight: 500; }
.count { display: inline-grid; place-items: center; min-width: 1.25rem; height: 1.25rem; margin-left: 0.35rem; padding: 0 0.3rem; border-radius: 999px; background: var(--rejected); color: #fff; font-size: 0.75rem; font-weight: 700; }
.bottom { display: none; }
@media (max-width: 760px) {
  .desktop { display: none; }
  .bottom {
    display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; position: fixed; bottom: 0; left: 0; right: 0; z-index: 20;
    background: var(--surface); border-top: 1px solid var(--border); padding-bottom: env(safe-area-inset-bottom);
  }
  .tab { display: flex; flex-direction: column; align-items: center; gap: 0.1rem; padding: 0.5rem 0; min-height: 56px; font-size: 0.8rem; color: var(--muted); text-decoration: none; }
  .tab.router-link-exact-active { color: var(--brand); }
}
</style>
