<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/api/client";
import type { DocumentType, Group, Policy } from "@/api/types";
import Banner from "@/components/Banner.vue";
import { openRequest } from "@/flows/signing";
import { formatVnd, parseVndInput } from "@/lib/format";
import { activePolicy, describeRequirement, ruleFor } from "@/lib/policy";
import { useSealed } from "@/stores/sealed";
import { useSession } from "@/stores/session";
import * as tide from "@/tide/tide";

const props = defineProps<{ id?: string }>();
const router = useRouter();
const session = useSession();
const sealed = useSealed();

const type = ref<DocumentType>("payment_voucher");
const title = ref("");
const amountInput = ref("");
const groupId = ref("general");
const counterparty = ref("");
const bankAccount = ref("");
const description = ref("");
const groups = ref<Group[]>([]);
const policy = ref<Policy | null>(null);
const sealingReady = ref(false);
const loading = ref(true);
const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const wasPending = ref(false);

const amountDong = computed(() => parseVndInput(amountInput.value));
const rule = computed(() => ruleFor(policy.value, type.value, amountDong.value));
const usePlaintext = computed(() => !sealingReady.value && !!session.config?.allowPlaintextDev);
const canSave = computed(() => !!title.value.trim() && !!amountDong.value && !!counterparty.value.trim() && (sealingReady.value || usePlaintext.value));

onMounted(async () => {
  try {
    const [g, p, setup] = await Promise.all([api.groups(), api.policies(), api.tideSetup()]);
    groups.value = g;
    policy.value = activePolicy(p);
    sealingReady.value = setup.sealedFields.configured;
    if (props.id) {
      const { document } = await api.document(props.id);
      wasPending.value = document.status === "pending_approval";
      type.value = document.type;
      title.value = document.title;
      amountInput.value = document.amountDong;
      groupId.value = document.resourceGroupId;
      await sealed.open([document], !!session.me?.canDecrypt);
      const v = sealed.view(document);
      if (v.state === "open") {
        counterparty.value = v.values.counterparty;
        bankAccount.value = v.values.bankAccount;
        description.value = v.values.description;
      } else {
        error.value = "You cannot read this document's sealed fields, so you cannot edit it.";
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

async function save(andSubmit: boolean) {
  if (!canSave.value || !amountDong.value) return;
  error.value = null;
  try {
    busy.value = "Encrypting sensitive fields with Tide…";
    const plain = { counterparty: counterparty.value.trim(), bankAccount: bankAccount.value.trim(), description: description.value.trim() };
    const input = {
      type: type.value, title: title.value.trim(), amountDong: amountDong.value, resourceGroupId: groupId.value,
      sealing: usePlaintext.value ? "plaintext-dev" : "tide-relationship-v1",
      sealed: usePlaintext.value ? plain : await sealed.seal(plain),
    };
    busy.value = "Saving…";
    const doc = props.id ? await api.editDocument(props.id, input) : await api.createDocument(input);
    if (andSubmit) {
      busy.value = "Freezing the content hash…";
      const { request } = await api.submit(doc.id);
      busy.value = "Opening the request on the Tide network…";
      const opened = await openRequest({ tide, api }, request);
      if (opened.requirement.initiatorMayApprove) return router.replace(`/approve/${opened.id}`);
    }
    await router.replace(`/documents/${doc.id}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <form class="stack" @submit.prevent="save(true)">
    <h1>{{ id ? "Edit draft" : "New document" }}</h1>
    <Banner v-if="wasPending" tone="pending">This document is waiting for approval. Saving an edit withdraws that request and returns it to Draft.</Banner>
    <Banner v-if="!loading && !sealingReady && !usePlaintext" tone="rejected">Field encryption is not set up yet. A realm admin must approve the sealed-fields policy in Tide setup before documents can be created.</Banner>
    <Banner v-if="usePlaintext" tone="rejected">Development mode: sensitive fields will be stored unencrypted.</Banner>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>

    <div class="grid-2">
      <div class="card">
        <div class="field">
          <label for="d-type">Type</label>
          <select id="d-type" v-model="type"><option value="payment_voucher">Phiếu chi · Payment voucher</option><option value="e_invoice">Hóa đơn · E-invoice</option></select>
        </div>
        <div class="field"><label for="d-title">Title</label><input id="d-title" v-model="title" maxlength="200" required /></div>
        <div class="field">
          <label for="d-amount">Amount (₫)</label>
          <input id="d-amount" v-model="amountInput" inputmode="numeric" placeholder="640000000" required class="num" />
          <p class="hint num">{{ amountDong ? formatVnd(amountDong) : "Whole đồng, digits only" }}</p>
        </div>
        <div class="field">
          <label for="d-group">Resource group</label>
          <select id="d-group" v-model="groupId"><option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option></select>
        </div>
        <fieldset class="card" style="background: var(--sealed-bg); border-color: var(--sealed)">
          <legend class="small" style="color: var(--sealed)">🔒 Sealed: encrypted by Tide in your browser</legend>
          <div class="field"><label for="d-cp">Counterparty</label><input id="d-cp" v-model="counterparty" required /></div>
          <div class="field"><label for="d-bank">Bank account</label><input id="d-bank" v-model="bankAccount" /></div>
          <div class="field"><label for="d-desc">Description</label><textarea id="d-desc" v-model="description" /></div>
        </fieldset>
      </div>
      <aside class="card stack">
        <h2>Approval rule</h2>
        <template v-if="rule">
          <p><strong>{{ rule.label }}</strong></p>
          <p>{{ describeRequirement(rule) }}</p>
          <p class="muted small">You cannot approve your own document{{ rule.initiatorMayApprove ? " (except in this band, where you sign alone and it is logged)" : "" }}. The Tide network checks the approvals again before it signs.</p>
        </template>
        <p v-else class="muted">Enter an amount to see which rule applies.</p>
      </aside>
    </div>

    <p v-if="busy" class="muted" role="status">{{ busy }}</p>
    <div class="row">
      <button type="button" class="btn" :disabled="!canSave || !!busy" @click="save(false)">Save draft</button>
      <button type="submit" class="btn btn-primary" :disabled="!canSave || !!busy || !session.has('drafter')">Save and submit for approval</button>
    </div>
  </form>
</template>
