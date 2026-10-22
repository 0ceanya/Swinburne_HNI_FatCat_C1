<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/api/client";
import type { Level, TideSetup } from "@/api/types";
import Banner from "@/components/Banner.vue";
import { registerKey, STEP_TEXT, type Step } from "@/flows/vault";
import { fileSecret, LEVEL_LABEL, quorumText } from "@/lib/format";
import { useSession } from "@/stores/session";
import * as tide from "@/tide/tide";

const MAX_FILE_BYTES = 48 * 1024;
const PROVIDERS = ["Viettel MySign", "VNPT SmartCA", "FPT-CA", "BKAV CA", "AWS", "Google Cloud", "Microsoft Azure", "Vietcombank", "Techcombank", "VNPAY", "MoMo"];

const router = useRouter();
const session = useSession();
const kinds = computed(() => session.config?.kinds ?? []);
const boardSize = computed(() => session.config?.boardSize ?? 3);

const kind = ref("digital_signature");
const level = ref<Level>(3);
const name = ref("");
const provider = ref("");
const description = ref("");
const hint = ref("");
const secretText = ref("");
const secretFile = ref<{ name: string; value: string } | null>(null);
const reveal = ref(false);
const setup = ref<TideSetup | null>(null);
const step = ref<Step | null>(null);
const error = ref<string | null>(null);

const selectedKind = computed(() => kinds.value.find((k) => k.id === kind.value));
const quorum = computed(() => Math.min(level.value, boardSize.value));
const policyReady = computed(() => !setup.value || setup.value.policies.some((p) => p.threshold === quorum.value && p.signed));
const secret = computed(() => secretFile.value?.value ?? secretText.value);
const canSave = computed(() => !!name.value.trim() && !!secret.value && policyReady.value && !step.value);

// Picking a type suggests its level; the registrar can still change it, and the board approves it.
watch(kind, (k) => { const d = kinds.value.find((x) => x.id === k)?.defaultLevel; if (d) level.value = d; });

onMounted(async () => {
  try { setup.value = await api.tideSetup(); } catch { /* the register call reports it */ }
});

async function pickFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) { secretFile.value = null; return; }
  if (file.size > MAX_FILE_BYTES) { error.value = `That file is over ${MAX_FILE_BYTES / 1024} KB.`; return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  secretFile.value = { name: file.name, value: fileSecret(file.name, file.type, tide.toBase64(bytes)) };
}

async function save() {
  if (!canSave.value) return;
  error.value = null;
  try {
    const out = await registerKey({ tide, api }, {
      name: name.value.trim(), kind: kind.value, provider: provider.value.trim(), description: description.value.trim(), hint: hint.value.trim(), level: level.value,
    }, secret.value, (s) => (step.value = s));
    secretText.value = "";
    secretFile.value = null;
    await router.replace(`/requests/${out.request.id}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    step.value = null;
  }
}
</script>

<template>
  <form class="stack" autocomplete="off" @submit.prevent="save">
    <h1>Add a key to the vault</h1>
    <Banner v-if="!policyReady" tone="rejected">The Tide network policy for {{ quorum }} approval{{ quorum === 1 ? "" : "s" }} is not signed yet. A realm admin must approve it in Tide setup first.</Banner>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>

    <div class="grid-2">
      <div class="card">
        <div class="field">
          <label for="k-kind">Type</label>
          <select id="k-kind" v-model="kind"><option v-for="k in kinds" :key="k.id" :value="k.id">{{ k.label }}</option></select>
          <p v-if="selectedKind" class="hint">e.g. {{ selectedKind.examples }}</p>
        </div>
        <div class="field"><label for="k-name">Name</label><input id="k-name" v-model="name" maxlength="120" required placeholder="e.g. Viettel MySign: company signing certificate" /></div>
        <div class="field">
          <label for="k-provider">Provider</label>
          <input id="k-provider" v-model="provider" list="k-providers" maxlength="80" />
          <datalist id="k-providers"><option v-for="p in PROVIDERS" :key="p" :value="p" /></datalist>
        </div>
        <div class="field">
          <label for="k-level">Permission level</label>
          <select id="k-level" v-model.number="level">
            <option v-for="l in ([1, 2, 3, 4] as Level[])" :key="l" :value="l">Level {{ l }} · {{ LEVEL_LABEL[l] }}</option>
          </select>
          <p class="hint">Needs {{ quorumText(level, boardSize) }} to seal it now and to unlock it each time.</p>
        </div>
        <div class="field"><label for="k-desc">What it is for (shown to approvers)</label><textarea id="k-desc" v-model="description" maxlength="500" /></div>
        <div class="field"><label for="k-hint">Hint (optional, not secret)</label><input id="k-hint" v-model="hint" maxlength="40" placeholder="e.g. ••••4821, or which account" /></div>
      </div>

      <aside class="card stack sealed-box">
        <h2>🔒 The secret</h2>
        <p class="small">Encrypted in this browser by Tide before it leaves. SignGuard's server only ever stores ciphertext, and the Tide network decrypts it only after {{ quorum }} board member{{ quorum === 1 ? "" : "s" }} approve.</p>
        <div class="field">
          <label for="k-secret">Paste it</label>
          <textarea id="k-secret" v-model="secretText" :disabled="!!secretFile" spellcheck="false" :class="{ masked: !reveal }" placeholder="API key, password, PIN, private key…" />
          <label class="small row" style="gap: 0.4rem; font-weight: 400; margin-top: 0.25rem"><input v-model="reveal" type="checkbox" style="width: auto; min-height: auto" /> Show while typing</label>
        </div>
        <div class="field">
          <label for="k-file">…or choose a file</label>
          <input id="k-file" type="file" @change="pickFile" />
          <p class="hint">A .p12/.pfx certificate or key file, up to {{ MAX_FILE_BYTES / 1024 }} KB.</p>
        </div>
      </aside>
    </div>

    <p v-if="step" class="muted" role="status">{{ STEP_TEXT[step] }}</p>
    <div class="row">
      <RouterLink to="/vault" class="btn">Cancel</RouterLink>
      <button type="submit" class="btn btn-primary" :disabled="!canSave">Encrypt and ask the board to seal it</button>
    </div>
  </form>
</template>

<style scoped>
.sealed-box { background: var(--sealed-bg); border-color: var(--sealed); }
.masked { -webkit-text-security: disc; }
</style>
