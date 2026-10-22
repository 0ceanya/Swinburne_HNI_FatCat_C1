import type { Tier } from "./tier.js";

/**
 * A person, as SignGuard last saw them sign in. Tiers here are a cache for display; every decision
 * reads the roles from the member's verified Tide token on that request.
 */
export interface MemberProps {
  id: string;
  vuid: string;
  username: string;
  firstName: string;
  lastName: string;
  tideUserKey: string;
  tiers: Tier[];
  onBoard: boolean;
  lastSeenAt: string;
}

export class Member {
  private constructor(private props: MemberProps) {}

  static restore(props: MemberProps): Member {
    return new Member({ ...props });
  }

  static seen(p: MemberProps): Member {
    return new Member({ ...p });
  }

  get id() { return this.props.id; }

  displayName(): string {
    const full = `${this.props.lastName} ${this.props.firstName}`.trim();
    return full || this.props.username;
  }

  snapshot(): MemberProps {
    return { ...this.props, tiers: [...this.props.tiers] };
  }
}
