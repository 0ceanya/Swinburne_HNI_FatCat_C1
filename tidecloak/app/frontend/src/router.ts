import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "inbox", component: () => import("@/views/InboxView.vue") },
    { path: "/auth/redirect", name: "auth-redirect", component: () => import("@/views/AuthRedirectView.vue"), meta: { public: true } },
    // Signed out, App.vue renders SignUpView for this path; signed in, it is just the inbox.
    { path: "/signup", name: "signup", component: () => import("@/views/InboxView.vue") },
    { path: "/documents", name: "documents", component: () => import("@/views/DocumentsView.vue") },
    { path: "/documents/new", name: "document-new", component: () => import("@/views/DocumentEditorView.vue") },
    { path: "/documents/:id", name: "document", component: () => import("@/views/DocumentDetailView.vue"), props: true },
    { path: "/documents/:id/edit", name: "document-edit", component: () => import("@/views/DocumentEditorView.vue"), props: true },
    { path: "/approve/:requestId", name: "approve", component: () => import("@/views/ApproveView.vue"), props: true },
    { path: "/policy", name: "policy", component: () => import("@/views/PolicyView.vue") },
    { path: "/members", name: "members", component: () => import("@/views/MembersView.vue") },
    { path: "/audit", name: "audit", component: () => import("@/views/AuditView.vue") },
    { path: "/setup", name: "setup", component: () => import("@/views/TideSetupView.vue") },
    { path: "/me", name: "me", component: () => import("@/views/MeView.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
