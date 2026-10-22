<script setup lang="ts">
/**
 * Post-signup details, ported from the Tide pack's onboarding modal (React) to Vue.
 *
 * Tide asserts only a username (the vuid): no name, no email. SignGuard needs a first and last name
 * so the audit log reads "approved by Lê Cường", not a 64-character id. The rules it keeps:
 *  1. It writes through the ACCOUNT API with the user's own token, never the Admin API.
 *  2. It is dismissible.
 *  3. It never invents a placeholder email.
 */
import { onMounted, ref } from "vue";
import { updateOwnProfile } from "@/tide/tide";

const props = defineProps<{ firstName?: string; lastName?: string }>();
const emit = defineEmits<{ done: [saved: boolean] }>();

const DISMISS_KEY = "signguard.profile-onboarding.dismissed";
const open = ref(false);
const firstName = ref(props.firstName ?? "");
const lastName = ref(props.lastName ?? "");
const busy = ref(false);
const error = ref<string | null>(null);

onMounted(() => {
  try {
    open.value = localStorage.getItem(DISMISS_KEY) !== "1";
  } catch {
    open.value = true;
  }
});

function dismiss() {
  try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
  open.value = false;
  emit("done", false);
}

async function save() {
  if (!firstName.value.trim() || !lastName.value.trim()) {
    error.value = "Please enter both your first and last name.";
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await updateOwnProfile({ firstName: firstName.value.trim(), lastName: lastName.value.trim() });
    open.value = false;
    emit("done", true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Something went wrong.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
    <form class="card dialog" @submit.prevent="save">
      <h2 id="onboarding-title">Welcome to SignGuard</h2>
      <p class="muted small">Your name appears on every approval you give and in the audit log. You can do this later from your profile.</p>
      <div class="field">
        <label for="ob-last">Last name (họ)</label>
        <input id="ob-last" v-model="lastName" autocomplete="family-name" required />
      </div>
      <div class="field">
        <label for="ob-first">First name (tên)</label>
        <input id="ob-first" v-model="firstName" autocomplete="given-name" required />
      </div>
      <p v-if="error" role="alert" class="small" style="color: var(--rejected)">{{ error }}</p>
      <div class="row" style="justify-content: flex-end">
        <button type="button" class="btn" :disabled="busy" @click="dismiss">Not now</button>
        <button type="submit" class="btn btn-primary" :disabled="busy">{{ busy ? "Saving…" : "Save" }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; display: grid; place-items: center; background: rgb(0 0 0 / 45%); z-index: 50; padding: 1rem; }
.dialog { width: min(28rem, 100%); }
</style>
