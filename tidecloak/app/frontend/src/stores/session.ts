import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api/client";
import type { Me, ServerConfig, Tier } from "@/api/types";
import * as tide from "@/tide/tide";

/**
 * Who is signed in. Roles here drive what the UI SHOWS; the server re-checks every action from the
 * verified token, and the Tide network re-checks every approval, so hiding a button is never the
 * security boundary.
 */
export const useSession = defineStore("session", () => {
  const ready = ref(false);
  const authenticated = ref(false);
  const me = ref<Me | null>(null);
  const config = ref<ServerConfig | null>(null);
  const error = ref<string | null>(null);
  const popupBlocked = ref(false);
  const waitingCount = ref(0);
  let poller: ReturnType<typeof setInterval> | null = null;

  const tiers = computed<Tier[]>(() => me.value?.tiers ?? []);
  const has = (...t: Tier[]) => t.some((x) => tiers.value.includes(x));
  const onBoard = computed(() => !!me.value?.onBoard);

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

  /** Keep the "waiting for you" count fresh, so a request shows up without a reload. */
  function startPolling() {
    if (poller) return;
    const tick = async () => {
      if (!onBoard.value) return;
      try { waitingCount.value = (await api.inbox()).waitingForMe.length; } catch { /* next tick */ }
    };
    void tick();
    poller = setInterval(tick, 10000);
  }

  return {
    ready, authenticated, me, config, error, popupBlocked, waitingCount, tiers, has, onBoard,
    start, loadMe,
    // Front-channel login ignores a return path, so remember it ourselves for /auth/redirect.
    login: (returnPath?: string) => {
      try { if (returnPath) sessionStorage.setItem("signguard.returnTo", returnPath); } catch { /* private mode */ }
      return tide.login();
    },
    logout: () => tide.logout(),
  };
});
