import { DomainError } from "../domain/errors.js";
import { BOARD_ROLE, tiersFromRoles } from "../domain/tier.js";
import type { DirectoryUser, TideDirectory } from "../usecases/ports.js";

export interface AdminCredential {
  username: string;
  password: string;
}

/**
 * Read-only TideCloak access with the master-admin credential from tidecloak/.env.
 *
 * LOCAL DEVELOPMENT ONLY, stated plainly: this puts an operator credential in the server process
 * (Tide's AP-41). SignGuard uses it for two reads only: the board's members and roles, and the realm
 * admin policy that Tide setup signs under. It never writes: the board and its roles are fixed.
 * Tokens live ~60 s, so one is minted per call.
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

  private async get(path: string): Promise<Response> {
    const send = async () => fetch(`${this.base}/admin/realms/${this.realm}${path}`, { headers: { Authorization: `Bearer ${await this.token()}` } });
    const res = await send();
    return res.status === 401 ? send() : res;
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.get(path);
    if (!res.ok) throw new DomainError("DIRECTORY_ERROR", `TideCloak ${path.split("?")[0]} answered HTTP ${res.status}`, 409);
    return (await res.json()) as T;
  }

  async adminPolicy(): Promise<string> {
    const res = await this.get("/iga/role-policies/name/tide-realm-admin");
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
    const users = await this.json<{ id: string; username: string; firstName?: string; lastName?: string; enabled: boolean; attributes?: Record<string, string[]> }[]>(
      "/users?max=500&briefRepresentation=false");
    const rm = await this.rmId();
    return Promise.all(users.map(async (u) => {
      const [realmRoles, rmRoles] = await Promise.all([
        this.json<{ name: string }[]>(`/users/${u.id}/role-mappings/realm/composite`),
        this.json<{ name: string }[]>(`/users/${u.id}/role-mappings/clients/${rm}/composite`),
      ]);
      const names = realmRoles.map((r) => r.name);
      return {
        id: u.id, username: u.username, firstName: u.firstName ?? "", lastName: u.lastName ?? "",
        linked: !!u.attributes?.tideUserKey?.[0], enabled: u.enabled,
        tiers: tiersFromRoles(names), onBoard: names.includes(BOARD_ROLE),
        isRealmAdmin: rmRoles.some((r) => r.name === "tide-realm-admin"),
      };
    }));
  }
}

/** Used when the server has no admin credential: the board list falls back to sign-ins, Tide setup is view-only. */
export const unavailableDirectory: TideDirectory = {
  available: false,
  adminPolicy: async () => { throw new DomainError("DIRECTORY_UNAVAILABLE", "No TideCloak admin credential configured", 409); },
  listUsers: async () => [],
};
