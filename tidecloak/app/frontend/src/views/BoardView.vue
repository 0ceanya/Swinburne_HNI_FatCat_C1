<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "@/api/client";
import type { BoardMember } from "@/api/types";
import Banner from "@/components/Banner.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { LEVEL_LABEL, quorumText, tierNames } from "@/lib/format";

const members = ref<BoardMember[]>([]);
const boardSize = ref(3);
const source = ref<"tidecloak" | "sign-ins">("tidecloak");
const loading = ref(true);
const error = ref<string | null>(null);
const board = computed(() => members.value.filter((m) => m.onBoard));
const others = computed(() => members.value.filter((m) => !m.onBoard));

onMounted(async () => {
  try {
    const out = await api.board();
    members.value = out.members;
    boardSize.value = out.boardSize;
    source.value = out.source;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="stack">
    <h1>Board</h1>
    <p class="muted">The people whose approvals unlock the vault. Membership and roles live in TideCloak and are fixed: SignGuard reads them and never changes them.</p>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <Banner v-if="source === 'sign-ins'" tone="neutral">Showing people who have signed in (the server has no TideCloak admin credential to list everyone).</Banner>
    <SkeletonRows v-if="loading" />
    <template v-else>
      <div class="card table-wrap">
        <table class="table">
          <thead><tr><th>Name</th><th>Roles</th><th>Tide</th></tr></thead>
          <tbody>
            <tr v-for="m in board" :key="m.id">
              <td><strong>{{ m.displayName }}</strong><div class="muted small">{{ m.username }}{{ m.isRealmAdmin ? " · realm admin" : "" }}</div></td>
              <td>{{ tierNames(m.tiers) }}</td>
              <td><StatusBadge :tone="m.linked ? 'approved' : 'pending'" :label="m.linked ? 'Linked' : 'Not linked'" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="others.length" class="muted small">Also signed up, not on the board: {{ others.map((m) => m.displayName).join(", ") }}.</p>

      <section class="card">
        <h2>Permission levels</h2>
        <table class="table">
          <thead><tr><th>Level</th><th>Needs</th></tr></thead>
          <tbody>
            <tr v-for="l in ([1, 2, 3, 4] as const)" :key="l"><td>Level {{ l }} · {{ LEVEL_LABEL[l] }}</td><td>{{ quorumText(l, boardSize) }}</td></tr>
          </tbody>
        </table>
        <p class="muted small" style="margin-top: 0.5rem">The board has {{ boardSize }} seats, so the highest level needs all {{ boardSize }}. The Tide network counts the approvals itself before it seals or decrypts anything.</p>
      </section>
    </template>
  </div>
</template>
