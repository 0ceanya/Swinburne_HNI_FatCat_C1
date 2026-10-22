import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "inbox", component: () => import("@/views/InboxView.vue") },
    { path: "/auth/redirect", name: "auth-redirect", component: () => import("@/views/AuthRedirectView.vue"), meta: { public: true } },
    // Signed out, App.vue renders SignUpView for this path; signed in, it is just the inbox.
    { path: "/signup", name: "signup", component: () => import("@/views/InboxView.vue") },
    { path: "/vault", name: "vault", component: () => import("@/views/VaultView.vue") },
    { path: "/vault/new", name: "key-new", component: () => import("@/views/KeyNewView.vue") },
    { path: "/vault/:id", name: "key", component: () => import("@/views/KeyDetailView.vue"), props: true },
    { path: "/requests/:id", name: "request", component: () => import("@/views/RequestView.vue"), props: true },
    { path: "/board", name: "board", component: () => import("@/views/BoardView.vue") },
    { path: "/audit", name: "audit", component: () => import("@/views/AuditView.vue") },
    { path: "/insights", name: "insights", component: () => import("@/views/InsightsView.vue") },
    { path: "/setup", name: "setup", component: () => import("@/views/TideSetupView.vue") },
    { path: "/me", name: "me", component: () => import("@/views/MeView.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
