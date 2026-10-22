<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api } from "@/api/client";
import type { Doc } from "@/api/types";
import Banner from "@/components/Banner.vue";
import EmptyState from "@/components/EmptyState.vue";
import SealedValue from "@/components/SealedValue.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { DOC_STATUS, DOC_TYPE_LABEL, formatVnd, parseVndInput } from "@/lib/format";
import { useSealed } from "@/stores/sealed";
import { useSession } from "@/stores/session";

const session = useSession();
const sealed = useSealed();
const docs = ref<Doc[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const type = ref("");
const status = ref("");
const minAmount = ref("");
const maxAmount = ref("");

async function load() {
  loading.value = true;
  error.value = null;
  try {
    docs.value = await api.documents({ type: type.value, status: status.value });
    void sealed.open(docs.value, !!session.me?.canDecrypt);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

const shown = computed(() => {
  const min = parseVndInput(minAmount.value);
  const max = parseVndInput(maxAmount.value);
  return docs.value.filter((d) => (min === null || BigInt(d.amountDong) >= BigInt(min)) && (max === null || BigInt(d.amountDong) <= BigInt(max)));
});

onMounted(load);
watch([type, status], load);
</script>

<template>
  <div class="stack">
    <div class="spread">
      <h1>Documents</h1>
      <RouterLink v-if="session.has('drafter')" to="/documents/new" class="btn btn-primary">+ New document</RouterLink>
    </div>
    <div class="card row" role="search">
      <div><label for="f-type">Type</label><select id="f-type" v-model="type"><option value="">All</option><option value="payment_voucher">Phiếu chi · Payment voucher</option><option value="e_invoice">Hóa đơn · E-invoice</option></select></div>
      <div><label for="f-status">Status</label><select id="f-status" v-model="status"><option value="">All</option><option value="draft">Draft</option><option value="pending_approval">Pending</option><option value="signed">Signed</option></select></div>
      <div><label for="f-min">Min amount (₫)</label><input id="f-min" v-model="minAmount" inputmode="numeric" placeholder="0" /></div>
      <div><label for="f-max">Max amount (₫)</label><input id="f-max" v-model="maxAmount" inputmode="numeric" placeholder="any" /></div>
    </div>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <SkeletonRows v-if="loading" />
    <EmptyState v-else-if="shown.length === 0" title="No documents match">Try clearing a filter{{ session.has("drafter") ? ", or create a new document" : "" }}.</EmptyState>
    <div v-else class="card table-wrap">
      <table class="table">
        <thead><tr><th>Number</th><th>Title</th><th>Counterparty</th><th style="text-align: right">Amount</th><th>Status</th></tr></thead>
        <tbody>
          <tr v-for="d in shown" :key="d.id">
            <td><RouterLink :to="`/documents/${d.id}`">{{ DOC_TYPE_LABEL[d.type] }} #{{ d.number }}</RouterLink></td>
            <td>{{ d.title }}</td>
            <td>
              <SealedValue v-bind="sealed.fieldView(d, 'counterparty')" :plaintext-dev="d.sealing === 'plaintext-dev'" />
            </td>
            <td class="num" style="text-align: right; white-space: nowrap">{{ formatVnd(d.amountDong) }}</td>
            <td><StatusBadge :tone="DOC_STATUS[d.status].tone" :label="DOC_STATUS[d.status].label" /></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
