<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { Tier } from "@/api/types";
import { useSession } from "@/stores/session";

const session = useSession();
const form = reactive({ lastName: "", firstName: "", requestedTier: "drafter" as Tier, email: "", note: "" });
const step = ref<"details" | "handoff">("details");
const ROLES: { tier: Tier; label: string; hint: string }[] = [
  { tier: "drafter", label: "Accountant / drafter", hint: "Creates payment vouchers and e-invoices" },
  { tier: "approver", label: "Approver", hint: "Approves documents a rule assigns to approvers" },
  { tier: "director", label: "Director", hint: "Approves documents over 20M ₫" },
  { tier: "viewer", label: "Viewer", hint: "Reads documents and their history" },
];
const valid = computed(() => !!form.lastName.trim() && !!form.firstName.trim() && (!form.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)));

function continueToTide() {
  if (!valid.value) return;
  step.value = "handoff";
  void session.signUp({ ...form, lastName: form.lastName.trim(), firstName: form.firstName.trim(), email: form.email.trim(), note: form.note.trim() });
}
</script>

<template>
  <main class="auth-page">
    <form class="card panel stack" @submit.prevent="continueToTide">
      <div class="row"><img src="/favicon.png" alt="" width="40" height="40" style="border-radius: 50%" /><h1 style="margin: 0">Create your SignGuard account</h1></div>
      <p class="muted small" style="margin: 0">Joining {{ session.config?.org.name ?? "the company" }}</p>

      <ol class="steps small">
        <li :class="{ on: step === 'details' }">Your details</li>
        <li :class="{ on: step === 'handoff' }">Create your Tide key</li>
        <li>Owner approves your role</li>
      </ol>

      <template v-if="step === 'details'">
        <div class="row">
          <div style="flex: 1"><label for="su-last">Last name (họ)</label><input id="su-last" v-model="form.lastName" autocomplete="family-name" required /></div>
          <div style="flex: 1"><label for="su-first">First name (tên)</label><input id="su-first" v-model="form.firstName" autocomplete="given-name" required /></div>
        </div>
        <fieldset class="roles">
          <legend>Your role</legend>
          <label v-for="r in ROLES" :key="r.tier" class="role">
            <input v-model="form.requestedTier" type="radio" name="tier" :value="r.tier" />
            <span><strong>{{ r.label }}</strong><br /><span class="muted small">{{ r.hint }}</span></span>
          </label>
        </fieldset>
        <div class="field"><label for="su-email">Work email (optional)</label><input id="su-email" v-model="form.email" type="email" autocomplete="email" /></div>
        <div class="field"><label for="su-note">Note to the owner (optional)</label><textarea id="su-note" v-model="form.note" placeholder="e.g. Kế toán chi nhánh Đồng Tháp" /></div>
        <button type="submit" class="btn btn-primary btn-block" :disabled="!valid">Continue to Tide</button>
        <p class="muted small">Next, Tide's window opens: choose <strong>Create an account</strong> and pick a username and password. That password goes to Tide's network, never to SignGuard. You'll land back here when you're done.</p>
      </template>
      <p v-else class="muted" role="status">Opening Tide…</p>

      <p class="small" style="margin: 0">Already have an account? <RouterLink to="/">Sign in</RouterLink></p>
    </form>
  </main>
</template>

<style scoped>
.auth-page { min-height: 100vh; display: grid; place-items: center; padding: 1rem; }
.panel { width: min(32rem, 100%); }
.steps { display: flex; gap: 0.5rem; padding: 0; margin: 0; list-style: none; counter-reset: s; flex-wrap: wrap; }
.steps li { counter-increment: s; color: var(--muted); }
.steps li::before { content: counter(s) ". "; }
.steps li.on { color: var(--brand); font-weight: 600; }
.roles { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.5rem 0.75rem; display: grid; gap: 0.5rem; }
.role { display: flex; gap: 0.6rem; align-items: flex-start; font-weight: 400; margin: 0; cursor: pointer; }
.role input { width: auto; min-height: auto; margin-top: 0.3rem; }
</style>
