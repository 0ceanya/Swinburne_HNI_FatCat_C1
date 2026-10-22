import { randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { DECRYPT_ROLE, ENCRYPT_ROLE, TIER_ROLE, TIERS, tiersFromRoles, type Tier } from "../domain/tier.js";
import type { ChangeOutcome, DirectoryUser, PendingChange, TideDirectory } from "../usecases/ports.js";

export interface AdminCredential {
  username: string;
  password: string;
}

const MANAGED_ROLES = new Set<string>([...Object.values(TIER_ROLE), ENCRYPT_ROLE, DECRYPT_ROLE]);
/** Order in which role grants are filed: what unlocks the most first. */
const ROLE_PRIORITY = [TIER_ROLE.owner, TIER_ROLE.director, TIER_ROLE.drafter, TIER_ROLE.approver, TIER_ROLE.viewer, DECRYPT_ROLE, ENCRYPT_ROLE];

/** Which realm roles a set of tiers maps to, including the Tide roles for sealed fields. */
export function rolesForTiers(tiers: Tier[]): string[] {
  const roles = new Set(tiers.map((t) => TIER_ROLE[t]));
  if (tiers.length > 0) roles.add(DECRYPT_ROLE); // every member may read sealed fields
  if (tiers.includes("drafter")) roles.add(ENCRYPT_ROLE); // only drafters write them
  return [...roles].sort();
}

/**
 * TideCloak administration with the master-admin credential from tidecloak/.env.
 *
 * LOCAL DEVELOPMENT ONLY, stated plainly: this puts an operator credential in the server process
 * (Tide's AP-41). What limits the damage is that on this IGA realm every governed write it makes
 * (granting a role, creating a user) only files a change request; a realm admin still has to sign
 * it in Tide's enclave before anything changes. Tokens live ~60 s, so one is minted per call.
 */
export class TideCloakDirectory implements TideDirectory {
  readonly available: boolean;
  private base: string;

  constructor(authServerUrl: string, private realm: string, private credential: AdminCredential | null) {
    this.base = authServerUrl.replace(/\/+$/, "");
    this.available = !!credential?.password;
  }

  private async token(): Promise<string> {
    if (!this.credential) throw new DomainError("DIRECTORY_UNAVAILABLE", "No TideCloak admin credential configured", 409);
    const res = await fetch(`${this.base}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: this.credential.username, password: this.credential.password }),
    });
    if (!res.ok) throw new DomainError("DIRECTORY_AUTH_FAILED", `TideCloak admin sign-in failed (HTTP ${res.status})`, 409);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const send = async () => fetch(`${this.base}/admin/realms/${this.realm}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const res = await send();
    return res.status === 401 ? send() : res;
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.call("GET", path);
    if (!res.ok) throw new DomainError("DIRECTORY_ERROR", `TideCloak ${path.split("?")[0]} answered HTTP ${res.status}`, 409);
    return (await res.json()) as T;
  }

  async adminPolicy(): Promise<string> {
    const res = await this.call("GET", "/iga/role-policies/name/tide-realm-admin");
    if (res.ok) {
      const body = (await res.json()) as { policy?: string };
      if (body.policy) return body.policy;
    }
    // Older builds have no by-name route. Look it up by exact name, never `[0]`.
    const all = await this.json<{ name?: string; policy?: string }[]>("/iga/role-policies");
    const matches = all.filter((p) => p.name === "tide-realm-admin" && p.policy);
    if (matches.length !== 1) throw new DomainError("ADMIN_POLICY_MISSING", `Expected exactly one tide-realm-admin policy, found ${matches.length}`, 409);
    return matches[0]!.policy!;
  }

  private realmManagementId?: string;
  private async rmId(): Promise<string> {
    if (!this.realmManagementId) {
      const [client] = await this.json<{ id: string }[]>("/clients?clientId=realm-management");
      if (!client) throw new DomainError("DIRECTORY_ERROR", "realm-management client not found", 409);
      this.realmManagementId = client.id;
    }
    return this.realmManagementId;
  }

  async listUsers(): Promise<DirectoryUser[]> {
    const users = await this.json<{ id: string; username: string; firstName?: string; lastName?: string; email?: string; enabled: boolean; attributes?: Record<string, string[]> }[]>(
      "/users?max=500&briefRepresentation=false");
    const rm = await this.rmId();
    return Promise.all(users.map(async (u) => {
      const [realmRoles, rmRoles] = await Promise.all([
        this.json<{ name: string }[]>(`/users/${u.id}/role-mappings/realm/composite`),
        this.json<{ name: string }[]>(`/users/${u.id}/role-mappings/clients/${rm}/composite`),
      ]);
      const names = realmRoles.map((r) => r.name);
      return {
        id: u.id, username: u.username, firstName: u.firstName ?? "", lastName: u.lastName ?? "", email: u.email ?? "",
        linked: !!u.attributes?.tideUserKey?.[0], enabled: u.enabled,
        tiers: tiersFromRoles(names), canEncrypt: names.includes(ENCRYPT_ROLE), canDecrypt: names.includes(DECRYPT_ROLE),
        isRealmAdmin: rmRoles.some((r) => r.name === "tide-realm-admin"),
      };
    }));
  }

  /**
   * TideCloak's IGA allows ONE pending change request per user: granting several roles in one call
   * files the first and refuses the rest (PENDING_CHANGE_REQUEST_CONFLICT). So role changes are filed
   * one at a time, most important first; call again after each approval to file the next.
   */
  async setTiers(userId: string, tiers: Tier[]): Promise<ChangeOutcome> {
    const wanted = rolesForTiers(tiers.filter((t) => TIERS.includes(t)));
    const direct = await this.json<{ id: string; name: string }[]>(`/users/${userId}/role-mappings/realm`);
    const have = new Set(direct.map((r) => r.name));
    const steps: { op: "add" | "remove"; role: string }[] = [
      ...ROLE_PRIORITY.filter((r) => wanted.includes(r) && !have.has(r)).map((role) => ({ op: "add" as const, role })),
      ...direct.filter((r) => MANAGED_ROLES.has(r.name) && !wanted.includes(r.name)).map((r) => ({ op: "remove" as const, role: r.name })),
    ];
    const describe = (s: { op: string; role: string }) => `${s.op === "add" ? "+" : "−"}${s.role}`;
    if (steps.length === 0) return { status: "unchanged", detail: "Already has exactly these tiers", remaining: [] };

    const waiting = (await this.pendingChanges()).find((c) => c.entityId === userId);
    if (waiting) {
      return {
        status: "pending",
        detail: `A change for this person (${waiting.actionType}) is already waiting for approval. Approve it in the Tide console, then request again.`,
        remaining: steps.map(describe),
      };
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const role = await this.json<{ id: string; name: string }>(`/roles/${encodeURIComponent(step.role)}`);
      const res = await this.call(step.op === "add" ? "POST" : "DELETE", `/users/${userId}/role-mappings/realm`, [role]);
      if (res.status === 202) {
        const rest = steps.slice(i + 1).map(describe);
        return {
          status: "pending",
          detail: `Filed ${describe(step)} as a change request. A realm admin approves it in the Tide console`
            + (rest.length ? `; then request again to file the next ${rest.length}.` : "."),
          remaining: rest,
        };
      }
      if (res.status >= 300) throw new DomainError("DIRECTORY_ERROR", `TideCloak refused ${describe(step)} (HTTP ${res.status}: ${(await res.text()).slice(0, 200)})`, 409);
    }
    return { status: "applied", detail: `Roles updated: ${steps.map(describe).join(" ")}`, remaining: [] };
  }

  async invite(input: { firstName: string; lastName: string; email?: string }) {
    const username = `sg-${input.firstName}-${input.lastName}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/đ/g, "d").replace(/[^a-z0-9-]+/g, "-").slice(0, 40) + "-" + randomBytes(2).toString("hex");
    const res = await this.call("POST", "/users", {
      username, firstName: input.firstName, lastName: input.lastName, ...(input.email ? { email: input.email } : {}),
      enabled: true, emailVerified: false, attributes: { tideInvitable: ["true"] },
    });
    if (res.status >= 300 && res.status !== 202) throw new DomainError("DIRECTORY_ERROR", `TideCloak refused the new user (HTTP ${res.status})`, 409);
    const found = await this.json<{ id: string }[]>(`/users?username=${encodeURIComponent(username)}&exact=true`);
    return {
      status: res.status === 202 ? "pending" as const : "applied" as const,
      detail: res.status === 202
        ? `Filed as a change request for ${username}. Approve it in the Tide console, then generate the invite link.`
        : `Created ${username}. Generate the invite link and send it to them.`,
      userId: found[0]?.id ?? null,
    };
  }

  async inviteLink(userId: string): Promise<string> {
    const res = await this.call("POST", `/tideAdminResources/get-required-action-link?userId=${encodeURIComponent(userId)}&lifespan=43200`, ["link-tide-account-action"]);
    const text = (await res.text()).trim().replace(/^"|"$/g, "");
    if (!res.ok || !text.startsWith("http")) {
      throw new DomainError("INVITE_UNAVAILABLE", `Could not create the invite link (HTTP ${res.status}). Is the user's creation approved yet?`, 409);
    }
    return text;
  }

  async pendingChanges(): Promise<PendingChange[]> {
    const items = await this.json<Record<string, unknown>[]>("/iga/change-requests?status=PENDING");
    return (Array.isArray(items) ? items : []).map((c) => ({
      id: String(c.id ?? ""),
      actionType: String(c.actionType ?? ""),
      entityType: String(c.entityType ?? ""),
      entityId: String(c.entityId ?? ""),
      summary: String(c.summary ?? c.description ?? c.entityName ?? `${c.actionType ?? ""} ${c.entityType ?? ""}`).trim(),
      createdAt: typeof c.createdAt === "string" ? c.createdAt : typeof c.createdAt === "number" ? new Date(c.createdAt).toISOString() : null,
    }));
  }
}

/** Used when the server has no admin credential: member management is switched off, clearly. */
export const unavailableDirectory: TideDirectory = {
  available: false,
  adminPolicy: async () => { throw new DomainError("DIRECTORY_UNAVAILABLE", "No TideCloak admin credential configured", 409); },
  listUsers: async () => [],
  setTiers: async () => { throw new DomainError("DIRECTORY_UNAVAILABLE", "No TideCloak admin credential configured", 409); },
  invite: async () => { throw new DomainError("DIRECTORY_UNAVAILABLE", "No TideCloak admin credential configured", 409); },
  inviteLink: async () => { throw new DomainError("DIRECTORY_UNAVAILABLE", "No TideCloak admin credential configured", 409); },
  pendingChanges: async () => [],
};
