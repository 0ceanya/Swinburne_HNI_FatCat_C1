import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api/client";
import type { JoinRequest, Me, ServerConfig, Tier } from "@/api/types";
import * as tide from "@/tide/tide";

const SIGNUP_KEY = "signguard.signup";

/** What the sign-up page collected before handing over to Tide to create the account's key. */
export interface PendingSignup {
  firstName: string;
  lastName: string;
  requestedTier: Tier;
  email: string;
  note: string;
}

/**
 * Who is signed in. Tiers here drive what the UI SHOWS; the server re-checks every action from the
 * verified token, so hiding a button is never the security boundary.
 */
export const useSession = defineStore("session", () => {
  const ready = ref(false);
  const authenticated = ref(false);
  const me = ref<Me | null>(null);
  const config = ref<ServerConfig | null>(null);
  const error = ref<string | null>(null);
  const popupBlocked = ref(false);
  const join = ref<JoinRequest | null>(null);
  const waitingCount = ref(0);
  let poller: ReturnType<typeof setInterval> | null = null;

  const tiers = computed<Tier[]>(() => me.value?.tiers ?? []);
  const has = (...t: Tier[]) => t.some((x) => tiers.value.includes(x));
  const isMember = computed(() => tiers.value.length > 0);
  const needsProfile = computed(() => !!me.value && !me.value.firstName && !me.value.lastName);

  async function start() {
    tide.onPopupBlocked(() => { popupBlocked.value = true; });
    try {
      authenticated.value = await tide.initTide();
    } catch (e) {
      error.value = `Could not reach TideCloak: ${e instanceof Error ? e.message : String(e)}`;
    }
    try {
      config.value = await api.config();
    } catch {
      // The API being down is reported on the first real call.
    }
    if (authenticated.value) {
      await loadMe();
      await finishSignup();
      startPolling();
    }
    ready.value = true;
  }

  async function loadMe() {
    try {
      me.value = await api.me();
      error.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  /** Back from Tide after signing up: save the name, then file the join request. */
  async function finishSignup() {
    let pending: PendingSignup | null = null;
    try { pending = JSON.parse(sessionStorage.getItem(SIGNUP_KEY) ?? "null"); } catch { pending = null; }
    if (!me.value || isMember.value) {
      try { sessionStorage.removeItem(SIGNUP_KEY); } catch { /* ignore */ }
      return;
    }
    if (pending) {
      try {
        if (!me.value.firstName && !me.value.lastName && (pending.firstName || pending.lastName)) {
          await tide.updateOwnProfile({ firstName: pending.firstName, lastName: pending.lastName });
          await loadMe();
        }
        join.value = await api.fileJoinRequest({
          requestedTier: pending.requestedTier, note: pending.note, email: pending.email,
          name: `${pending.lastName} ${pending.firstName}`.trim(),
        });
        sessionStorage.removeItem(SIGNUP_KEY);
      } catch (e) {
        error.value = `Your account was created, but sending the join request failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else {
      await loadJoin();
    }
  }

  async function loadJoin() {
    try { join.value = (await api.myJoinRequest()).request; } catch { join.value = null; }
  }

  /** Keep the "waiting for you" count fresh, so a request shows up without a reload. */
  function startPolling() {
    if (poller) return;
    const tick = async () => {
      if (!isMember.value) return;
      try { waitingCount.value = (await api.inbox()).waitingForMe.length; } catch { /* next tick */ }
    };
    void tick();
    poller = setInterval(tick, 10000);
  }

  return {
    ready, authenticated, me, config, error, popupBlocked, join, waitingCount, tiers, has, isMember, needsProfile,
    start, loadMe, loadJoin,
    // Front-channel login ignores a return path, so remember it ourselves for /auth/redirect.
    login: (returnPath?: string) => {
      try { if (returnPath) sessionStorage.setItem("signguard.returnTo", returnPath); } catch { /* private mode */ }
      return tide.login();
    },
    /** Sign-up: keep the details, then let Tide create the account's key and password. */
    signUp: (details: PendingSignup) => {
      try { sessionStorage.setItem(SIGNUP_KEY, JSON.stringify(details)); } catch { /* private mode */ }
      return tide.login();
    },
    logout: () => tide.logout(),
  };
});
