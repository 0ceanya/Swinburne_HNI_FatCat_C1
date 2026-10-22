<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "@/api/client";
import type { DirectoryMember, JoinRequest, PendingChange, Tier } from "@/api/types";
import Banner from "@/components/Banner.vue";
import SkeletonRows from "@/components/SkeletonRows.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { formatTime, TIER_LABEL, tierNames, timeAgo } from "@/lib/format";
import { useSession } from "@/stores/session";
import { approveChangeRequest } from "@/tide/tide";

const TIERS: Tier[] = ["viewer", "drafter", "approver", "director", "owner"];
const ACTION_LABEL: Record<string, string> = {
  GRANT_ROLES: "Grant role", REVOKE_ROLES: "Remove role", CREATE_USER: "Create account", SET_USER_ATTRIBUTE: "Update account",
};
const session = useSession();
const members = ref<DirectoryMember[]>([]);
const pending = ref<PendingChange[]>([]);
const joins = ref<JoinRequest[]>([]);
const consoleUrl = ref("");
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref<string | null>(null);
const editing = reactive(new Map<string, Tier[]>());
const invite = reactive({ firstName: "", lastName: "", email: "" });
const links = reactive(new Map<string, string>());

const nameOf = (userId: string) => members.value.find((m) => m.id === userId)?.displayName ?? "someone";
const canApproveInTide = computed(() => !!session.me?.isRealmAdmin);

async function load() {
  try {
    const out = await api.members();
    members.value = out.members;
    pending.value = out.pendingChanges;
    joins.value = out.joinRequests;
    consoleUrl.value = out.tideConsoleUrl;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function act(label: string, fn: () => Promise<string>) {
  error.value = null;
  notice.value = null;
  busy.value = label;
  try {
    notice.value = await fn();
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    await load();
  } finally {
    busy.value = null;
  }
}

const describe = (out: { status: string; detail: string; remaining?: string[] }) =>
  out.remaining?.length ? `${out.detail} (${out.remaining.length} more after that.)` : out.detail;

/** Approve one governance change in Tide, then file the next step of that person's tier change. */
const approveChange = (c: PendingChange) => act(`Approving: confirm in the Tide window…`, async () => {
  await approveChangeRequest(c.id);
  const member = members.value.find((m) => m.id === c.entityId);
  if (member?.targetTiers) {
    const next = await api.continueTiers(member.id);
    return next.status === "pending" ? `Approved. Filed the next step for ${member.displayName}: ${describe(next)}` : `Approved. ${member.displayName} now has all requested roles.`;
  }
  return "Approved in Tide.";
});

const decideJoin = (j: JoinRequest, decision: "approve" | "reject") => act(decision === "approve" ? "Approving…" : "Declining…", async () => {
  const out = await api.decideJoinRequest(j.id, decision);
  if (decision === "reject") return `Declined ${j.name}'s request.`;
  return `Approved ${j.name} as ${TIER_LABEL[j.requestedTier]}. ${out.outcome ? describe(out.outcome) : ""} Approve each step below in Tide.`;
});

function toggle(m: DirectoryMember, t: Tier) {
  const cur = editing.get(m.id) ?? [...m.tiers];
  editing.set(m.id, cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
}

// TideCloak allows one pending change per person, so a tier change may take several approvals:
// each approval below files the next role change automatically.
const saveTiers = (m: DirectoryMember) => act("Filing the change…", async () => {
  const out = await api.setTiers(m.id, editing.get(m.id) ?? m.tiers);
  editing.delete(m.id);
  return describe(out);
});
const sendInvite = () => act("Inviting…", async () => {
  const out = await api.invite({ firstName: invite.firstName, lastName: invite.lastName, email: invite.email || undefined });
  invite.firstName = invite.lastName = invite.email = "";
  return out.detail;
});
const getLink = (m: DirectoryMember) => act("Creating the link…", async () => {
  links.set(m.id, (await api.inviteLink(m.id)).link);
  return `Invite link for ${m.displayName} is ready. Send it to them privately.`;
});

onMounted(load);
</script>

<template>
  <div class="stack">
    <h1>Members</h1>
    <Banner v-if="error" tone="rejected">{{ error }}</Banner>
    <Banner v-if="notice" tone="approved">{{ notice }}</Banner>
    <p v-if="busy" class="muted" role="status">{{ busy }}</p>

    <section v-if="session.has('owner') && joins.length" class="stack">
      <h2>Asking to join ({{ joins.length }})</h2>
      <div v-for="j in joins" :key="j.id" class="card spread">
        <div>
          <strong>{{ j.name }}</strong> wants to be <strong>{{ TIER_LABEL[j.requestedTier] }}</strong>
          <div class="muted small">Signed up with Tide {{ timeAgo(j.createdAt) }}{{ j.email ? ` · ${j.email}` : "" }}</div>
          <div v-if="j.note" class="small">“{{ j.note }}”</div>
        </div>
        <div class="row">
          <button class="btn btn-reject" :disabled="!!busy" @click="decideJoin(j, 'reject')">Decline</button>
          <button class="btn btn-primary" :disabled="!!busy" @click="decideJoin(j, 'approve')">Approve</button>
        </div>
      </div>
    </section>

    <section v-if="pending.length" class="stack">
      <h2>Waiting for approval in Tide ({{ pending.length }})</h2>
      <p class="muted small">Role and account changes take effect only after a realm admin signs them in Tide's window. TideCloak allows one pending change per person, so each role is its own step.</p>
      <div v-for="c in pending" :key="c.id" class="card spread">
        <div>
          <strong>{{ ACTION_LABEL[c.actionType] ?? c.actionType }}</strong> for {{ nameOf(c.entityId) }}
          <div class="muted small">{{ c.summary }}{{ c.createdAt ? ` · ${formatTime(c.createdAt)}` : "" }}</div>
        </div>
        <button v-if="canApproveInTide" class="btn btn-approve" :disabled="!!busy" @click="approveChange(c)">Approve in Tide ✓</button>
        <a v-else :href="consoleUrl" target="_blank" rel="noopener" class="small">A realm admin approves this</a>
      </div>
    </section>

    <SkeletonRows v-if="loading" />
    <div v-else class="card table-wrap">
      <table class="table">
        <thead><tr><th>Name</th><th>Tiers</th><th>Tide</th><th v-if="session.has('owner')"></th></tr></thead>
        <tbody>
          <tr v-for="m in members" :key="m.id">
            <td>
              <strong>{{ m.displayName }}</strong>
              <div class="muted small">{{ m.username }}{{ m.isRealmAdmin ? " · realm admin" : "" }}</div>
            </td>
            <td>
              <div v-if="session.has('owner') && editing.has(m.id)" class="row">
                <label v-for="t in TIERS" :key="t" class="small" style="display: inline-flex; gap: 0.25rem; align-items: center; margin: 0">
                  <input type="checkbox" style="width: auto; min-height: auto" :checked="editing.get(m.id)!.includes(t)" @change="toggle(m, t)" />{{ TIER_LABEL[t] }}
                </label>
              </div>
              <span v-else>{{ tierNames(m.tiers) || "none" }}</span>
              <div v-if="m.targetTiers" class="muted small">Changing to: {{ tierNames(m.targetTiers) }}</div>
            </td>
            <td>
              <StatusBadge :tone="m.linked ? 'approved' : 'pending'" :label="m.linked ? 'Linked' : 'Not linked yet'" />
              <div v-if="m.pendingChange" style="margin-top: 0.25rem"><StatusBadge tone="pending" label="Change waiting in Tide" /></div>
            </td>
            <td v-if="session.has('owner')">
              <div class="row">
                <button v-if="!editing.has(m.id)" class="btn" :disabled="!!busy" @click="editing.set(m.id, [...m.tiers])">Change tier</button>
                <button v-else class="btn btn-primary" :disabled="!!busy" @click="saveTiers(m)">Request change</button>
                <button v-if="!m.linked" class="btn" :disabled="!!busy" @click="getLink(m)">Invite link</button>
              </div>
              <input v-if="links.get(m.id)" :value="links.get(m.id)" readonly class="small" style="margin-top: 0.5rem" @focus="($event.target as HTMLInputElement).select()" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <form v-if="session.has('owner')" class="card stack" @submit.prevent="sendInvite">
      <h2>Invite a member</h2>
      <p class="muted small">Or send them the sign-up page: <code>/signup</code>. An invite creates their account as a change request; after it's approved, generate their invite link here.</p>
      <div class="row">
        <div><label for="inv-last">Last name</label><input id="inv-last" v-model="invite.lastName" required /></div>
        <div><label for="inv-first">First name</label><input id="inv-first" v-model="invite.firstName" required /></div>
        <div><label for="inv-email">Email (optional)</label><input id="inv-email" v-model="invite.email" type="email" /></div>
      </div>
      <button type="submit" class="btn btn-primary" :disabled="!invite.firstName || !invite.lastName || !!busy">Invite</button>
    </form>
  </div>
</template>
