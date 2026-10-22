import { invalid } from "./errors.js";
import type { Tier } from "./tier.js";

/**
 * A person in the organisation, as SignGuard last saw them. Tiers here are a cache for display;
 * every decision reads the tiers from the member's verified Tide token on that request.
 */
export interface MemberProps {
  id: string;
  vuid: string;
  username: string;
  firstName: string;
  lastName: string;
  tideUserKey: string;
  tiers: Tier[];
  resourceGroups: string[];
  lastSeenAt: string;
}

export class Member {
  private constructor(private props: MemberProps) {}

  static restore(props: MemberProps): Member {
    return new Member({ ...props });
  }

  static seen(p: Omit<MemberProps, "resourceGroups">, existing: Member | null): Member {
    return new Member({ ...p, resourceGroups: existing?.props.resourceGroups ?? ["general"] });
  }

  get id() { return this.props.id; }
  get resourceGroups() { return this.props.resourceGroups; }

  displayName(): string {
    const full = `${this.props.lastName} ${this.props.firstName}`.trim();
    return full || this.props.username;
  }

  belongsTo(groupId: string): boolean {
    return this.props.resourceGroups.includes(groupId);
  }

  setResourceGroups(groups: string[]): void {
    if (groups.length === 0) throw invalid("A member needs at least one resource group", "INVALID_GROUPS");
    this.props = { ...this.props, resourceGroups: [...new Set(groups)] };
  }

  snapshot(): MemberProps {
    return { ...this.props, tiers: [...this.props.tiers], resourceGroups: [...this.props.resourceGroups] };
  }
}

export interface ResourceGroup {
  id: string;
  name: string;
  costCentre: string;
}
