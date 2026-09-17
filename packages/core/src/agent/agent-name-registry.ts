import { randomInt } from "node:crypto";
import { GREAT_NAME_POOL } from "./agent-name-pool.js";

/** Shuffled round-robin names within one roster. IDs remain the routing authority.
 * Reservations survive release: a revived session never inherits another agent's name.
 */
export class AgentNameRegistry {
  private readonly names = new Map<string, string>();
  /** Owner id -> (domain -> successful completions). Per-roster, like the names: it lives as long as the swarm that keeps the registry. */
  private readonly affinities = new Map<string, Map<string, number>>();
  private readonly order: string[];
  private next = 0;

  constructor() {
    this.order = [...GREAT_NAME_POOL];
    if (!this.order.length || new Set(this.order).size !== this.order.length) {
      throw new Error("Agent name pool must be nonempty and unique");
    }
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      const previous = this.order[i]!;
      this.order[i] = this.order[j]!;
      this.order[j] = previous;
    }
  }

  assign(ownerId: string): string {
    const existing = this.names.get(ownerId);
    if (existing !== undefined) return existing;
    const index = this.next++;
    const cycle = Math.floor(index / this.order.length);
    const base = this.order[index % this.order.length]!;
    const name = cycle === 0 ? base : `${base} ${cycle + 1}`;
    this.names.set(ownerId, name);
    return name;
  }

  nameOf(ownerId: string): string | null {
    return this.names.get(ownerId) ?? null;
  }

  /** Records one successful completion in a task domain; an empty domain is a caller bug, not a stat. */
  recordSuccess(ownerId: string, domain: string): void {
    if (!domain) throw new Error("Affinity domain must be a nonempty identifier");
    const domains = this.affinities.get(ownerId);
    if (domains) domains.set(domain, (domains.get(domain) ?? 0) + 1);
    else this.affinities.set(ownerId, new Map([[domain, 1]]));
  }

  /** Successful completions recorded for the owner in the domain (0 when none). */
  getAffinity(ownerId: string, domain: string): number {
    return this.affinities.get(ownerId)?.get(domain) ?? 0;
  }

  /** The owner's domains, best first (count descending; ties keep first-recorded order). */
  affinityDomains(ownerId: string): string[] {
    return [...(this.affinities.get(ownerId)?.entries() ?? [])]
      .sort((a, b) => b[1] - a[1])
      .map(([domain]) => domain);
  }
}
