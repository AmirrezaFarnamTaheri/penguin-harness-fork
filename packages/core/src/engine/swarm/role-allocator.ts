/**
 * Dynamic role allocator for the multi-agent swarm.
 *
 * Problem this solves: `agent/swarm-coordinator.ts` registers a *fixed* roster
 * (orchestrator/coder/reviewer/tester/researcher) and a *fixed* edge set. That
 * is the right thing for a pipeline. A mesh that wants to self-organize needs
 * something different — roles assigned *to whoever is best suited right now*,
 * and reassigned when an agent is overloaded, fails, or a better fit appears.
 * This module is that decision; it deliberately does not touch the
 * coordinator's roster, it produces allocations the caller can apply.
 *
 * The algorithm is a real constrained greedy assignment, not a lookup:
 *  1. Score every (agent, role) pair. The score has one base term and two
 *     additive bonuses, deliberately never multiplied together:
 *      - base: capability coverage, the product of proficiency over the role's
 *        *required* capabilities. Any missing required capability scores the
 *        pair zero — a hard gate, not a soft penalty.
 *      - bonus: mean proficiency over the *preferred* capabilities, weighted
 *        by `preferredCapabilityWeight`. Preferred caps raise a score but can
 *        never gate or zero it, so an agent with the required skills but none
 *        of the nice-to-have ones still gets a real, non-zero score.
 *      - bonus: a flat `preferenceBonus` for roles the agent declared interest
 *        in, again never a gate.
 *     A load term scales the base (an agent already at its load ceiling scores
 *     zero), and recent failures scale it multiplicatively.
 *  2. Sort candidate pairs by role priority (desc), then score (desc).
 *  3. Assign greedily, honouring per-role `maxConcurrent` and per-agent
 *     `exclusive` roles (an agent holding an exclusive role gets no others).
 *  4. Rebalancing is sticky: an incumbent keeps its role unless a challenger
 *     beats it by more than `hysteresis`, so measurement noise does not make
 *     the mesh thrash.
 *
 * Roles follow the plan's §8 naming (Tier 4 presets: Architect Lead, Bug
 * Isolator, TDD Test Engineer, Code Polisher, Security Verifier, Researcher),
 * with no upstream/vendor naming anywhere.
 */

export type SwarmRoleId =
  | "architect_lead"
  | "bug_isolator"
  | "test_engineer"
  | "code_polisher"
  | "security_reviewer"
  | "researcher"
  | "orchestrator";

export interface RoleDefinition {
  id: SwarmRoleId;
  label: string;
  summary: string;
  /** Capability names an agent MUST have (0..1 proficiency) to be eligible at all. */
  requiredCapabilities: readonly string[];
  /** Capabilities that raise the score but are not gating. */
  preferredCapabilities: readonly string[];
  /** Higher priority roles are staffed first from the same candidate pool. */
  priority: number;
  /** Only one agent may hold this role at once. */
  exclusive: boolean;
  /** How many agents may hold this role concurrently (exclusive implies 1). */
  maxConcurrent: number;
}

export interface AgentProfile {
  id: string;
  /** Capability name -> proficiency in [0, 1]. Missing means zero. */
  capabilities: Record<string, number>;
  /** Current load in [0, 1]; 1 means fully saturated and unassignable. */
  load: number;
  /** Roles this agent has asked for; small score bonus, never a gate. */
  preferences?: SwarmRoleId[];
  /** Assignment priority used only as a tie-break (seniority). */
  seniority?: number;
  /** Set when the agent has failed recently; see `fail`. */
  failures?: number;
}

export interface ScoredPair {
  agentId: string;
  roleId: SwarmRoleId;
  score: number;
  coverage: number;
  eligible: boolean;
  reasons: string[];
}

export interface RoleAllocation {
  assignments: Array<{
    roleId: SwarmRoleId;
    agentId: string;
    score: number;
    incumbent: boolean;
  }>;
  unassigned: SwarmRoleId[];
  scores: ScoredPair[];
  computedAt: number;
  generation: number;
}

export interface RoleAllocatorOptions {
  /** Load at/beyond which an agent is not considered for new roles. */
  loadCeiling?: number;
  /** Score advantage a challenger needs to displace an incumbent. */
  hysteresis?: number;
  /** Weight of the preference bonus. */
  preferenceBonus?: number;
  /** Weight of the preferred-capability bonus (additive, never a gate). */
  preferredCapabilityWeight?: number;
  /** Proficiency below this on a required capability counts as absent. */
  capabilityFloor?: number;
  /** Penalty per recent failure, applied multiplicatively. */
  failurePenalty?: number;
  /** Max roles one agent may hold at once; spreads work instead of stacking it. */
  maxRolesPerAgent?: number;
}

export const STANDARD_SWARM_ROLES: readonly RoleDefinition[] = Object.freeze([
  {
    id: "orchestrator",
    label: "Orchestrator",
    summary: "Decomposes the objective, staffs the other roles, and adjudicates between them.",
    requiredCapabilities: ["planning", "delegation"],
    preferredCapabilities: ["consensus", "grounding"],
    priority: 100,
    exclusive: true,
    maxConcurrent: 1,
  },
  {
    id: "architect_lead",
    label: "Architect Lead",
    summary: "Owns module boundaries and interface contracts before implementation starts.",
    requiredCapabilities: ["architecture", "design"],
    preferredCapabilities: ["code_review", "documentation"],
    priority: 90,
    exclusive: true,
    maxConcurrent: 1,
  },
  {
    id: "security_reviewer",
    label: "Security Reviewer",
    summary: "Threat-models every change and can veto a submission on a finding.",
    requiredCapabilities: ["security", "code_review"],
    preferredCapabilities: ["threat_modeling", "cryptography"],
    priority: 80,
    exclusive: false,
    maxConcurrent: 2,
  },
  {
    id: "bug_isolator",
    label: "Bug Isolator",
    summary: "Reproduces the failure and pins it to a commit and a code path.",
    requiredCapabilities: ["debugging", "testing"],
    preferredCapabilities: ["profiling", "git"],
    priority: 70,
    exclusive: false,
    maxConcurrent: 2,
  },
  {
    id: "test_engineer",
    label: "TDD Test Engineer",
    summary: "Writes the failing test first, then the implementation that turns it green.",
    requiredCapabilities: ["testing", "implementation"],
    preferredCapabilities: ["debugging", "ci"],
    priority: 60,
    exclusive: false,
    maxConcurrent: 3,
  },
  {
    id: "code_polisher",
    label: "Code Polisher",
    summary: "Refactors and de-slops without changing behaviour; the last eyes before submit.",
    requiredCapabilities: ["refactoring", "code_review"],
    preferredCapabilities: ["style", "performance"],
    priority: 40,
    exclusive: false,
    maxConcurrent: 2,
  },
  {
    id: "researcher",
    label: "Researcher",
    summary: "Gathers evidence and grounds claims before the mesh acts on them.",
    requiredCapabilities: ["research"],
    preferredCapabilities: ["grounding", "documentation"],
    priority: 30,
    exclusive: false,
    maxConcurrent: 4,
  },
]);

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export class RoleAllocator {
  private readonly roles = new Map<SwarmRoleId, RoleDefinition>();
  private readonly agents = new Map<string, AgentProfile>();
  private current: RoleAllocation | null = null;
  private generation = 0;
  private readonly options: Required<RoleAllocatorOptions>;

  /**
   * Accepts either the role list, the options, or both. `new RoleAllocator()`
   * uses the standard roster; `new RoleAllocator({ hysteresis: 0.2 })` tunes the
   * scorer without restaffing the roles. The argument order is inspected, not
   * guessed at: only an array-like is treated as a role list.
   */
  constructor(
    rolesOrOptions?: readonly RoleDefinition[] | RoleAllocatorOptions,
    options: RoleAllocatorOptions = {},
  ) {
    const roles = Array.isArray(rolesOrOptions)
      ? rolesOrOptions
      : (STANDARD_SWARM_ROLES as readonly RoleDefinition[]);
    const tuning =
      (Array.isArray(rolesOrOptions) ? options : (rolesOrOptions as RoleAllocatorOptions)) ?? {};

    for (const role of roles) {
      if (this.roles.has(role.id)) {
        throw new Error(`Duplicate swarm role id '${role.id}' in allocator`);
      }
      this.roles.set(role.id, { ...role });
    }
    this.options = {
      loadCeiling: tuning.loadCeiling ?? 0.9,
      hysteresis: tuning.hysteresis ?? 0.1,
      preferenceBonus: tuning.preferenceBonus ?? 0.1,
      // Preferred caps are a bonus, not a gate: a quarter-point of score per
      // unit of mean preferred proficiency, small enough that a strong
      // required-capability fit still dominates a nice-to-have one.
      preferredCapabilityWeight: tuning.preferredCapabilityWeight ?? 0.25,
      capabilityFloor: tuning.capabilityFloor ?? 0.2,
      // 0.5 per failure: three failures cost ~87% of a score, enough to actually
      // displace an incumbent rather than merely dinging them.
      failurePenalty: tuning.failurePenalty ?? 0.5,
      maxRolesPerAgent: tuning.maxRolesPerAgent ?? 3,
    };
  }

  public registerAgent(profile: AgentProfile): AgentProfile {
    const id = profile.id.trim();
    if (!id) throw new Error("Agent profile id cannot be empty");
    const stored: AgentProfile = {
      ...profile,
      id,
      capabilities: { ...profile.capabilities },
      load: clamp01(profile.load),
      preferences: profile.preferences ? [...profile.preferences] : undefined,
    };
    this.agents.set(id, stored);
    return { ...stored, capabilities: { ...stored.capabilities } };
  }

  public unregisterAgent(agentId: string): boolean {
    return this.agents.delete(agentId.trim());
  }

  public getAgent(agentId: string): AgentProfile | undefined {
    const profile = this.agents.get(agentId.trim());
    return profile
      ? {
          ...profile,
          capabilities: { ...profile.capabilities },
          preferences: profile.preferences?.slice(),
        }
      : undefined;
  }

  /** Records a failure so the next allocation demotes this agent multiplicatively. */
  public fail(agentId: string, count = 1): void {
    const profile = this.agents.get(agentId.trim());
    if (!profile) return;
    profile.failures = Math.max(0, (profile.failures ?? 0) + count);
  }

  public clearFailures(agentId: string): void {
    const profile = this.agents.get(agentId.trim());
    if (profile) profile.failures = 0;
  }

  public listRoles(): RoleDefinition[] {
    return Array.from(this.roles.values()).map((role) => ({ ...role }));
  }

  public getCurrentAllocation(): RoleAllocation | null {
    return this.current ? this.cloneAllocation(this.current) : null;
  }

  /**
   * Scores one (agent, role) pair. Pure: no allocation state is consulted, so
   * callers can reason about a single pairing before running a full pass.
   */
  public scorePair(agent: AgentProfile, role: RoleDefinition): ScoredPair {
    const reasons: string[] = [];
    const floor = this.options.capabilityFloor;
    const proficiency = (name: string): number => {
      const value = agent.capabilities[name];
      if (value === undefined || Number.isNaN(value)) return 0;
      return clamp01(value);
    };

    let requiredProduct = 1;
    let gated = true;
    for (const name of role.requiredCapabilities) {
      const value = proficiency(name);
      if (value < floor) {
        gated = false;
        reasons.push(
          `missing required capability '${name}' (${value.toFixed(2)} < floor ${floor})`,
        );
      }
      requiredProduct *= Math.max(value, floor);
    }
    if (!gated) {
      return {
        agentId: agent.id,
        roleId: role.id,
        score: 0,
        coverage: 0,
        eligible: false,
        reasons,
      };
    }

    let preferredSum = 0;
    for (const name of role.preferredCapabilities) {
      preferredSum += proficiency(name.trim());
    }
    const preferred =
      role.preferredCapabilities.length > 0 ? preferredSum / role.preferredCapabilities.length : 0;
    /** Coverage of the *required* capabilities — the score's base term. */
    const coverage = requiredProduct;

    if (agent.load >= this.options.loadCeiling) {
      reasons.push(
        `load ${agent.load.toFixed(2)} at/above ceiling ${this.options.loadCeiling.toFixed(2)}`,
      );
      return {
        agentId: agent.id,
        roleId: role.id,
        score: 0,
        coverage,
        eligible: false,
        reasons,
      };
    }

    const loadTerm = 1 - clamp01(agent.load);
    const prefers = agent.preferences?.includes(role.id) === true;
    const preference = prefers ? this.options.preferenceBonus : 0;
    const failureMultiplier = Math.pow(
      this.options.failurePenalty,
      Math.max(0, agent.failures ?? 0),
    );

    // Base coverage times load times failure history, then additive bonuses.
    // The bonuses are added, never multiplied, so an agent who has every
    // required capability but no preferred one still scores on its coverage
    // alone — and failures, load and preferences still move the real number.
    const score = clamp01(
      coverage * loadTerm * failureMultiplier +
        this.options.preferredCapabilityWeight * preferred +
        preference,
    );
    if (prefers) reasons.push("declared preference for role");
    if ((agent.failures ?? 0) > 0)
      reasons.push(`${agent.failures} recent failure(s) x${failureMultiplier.toFixed(2)}`);

    return {
      agentId: agent.id,
      roleId: role.id,
      score,
      coverage,
      eligible: true,
      reasons,
    };
  }

  /**
   * Runs the allocation pass. Idempotent for unchanged inputs modulo the
   * hysteresis rule — call after load changes, joins, or failures.
   */
  public allocate(): RoleAllocation {
    const rolesByPriority = Array.from(this.roles.values()).sort((a, b) => b.priority - a.priority);
    const pairs: ScoredPair[] = [];

    for (const role of rolesByPriority) {
      for (const agent of this.agents.values()) {
        pairs.push(this.scorePair(agent, role));
      }
    }

    const incumbents = new Map<SwarmRoleId, string>();
    for (const assignment of this.current?.assignments ?? []) {
      incumbents.set(assignment.roleId, assignment.agentId);
    }

    /** Sort: priority desc, then score desc, then seniority desc as tie-break. */
    const ranked = pairs
      .filter((pair) => pair.eligible)
      .sort((a, b) => {
        const roleA = this.roles.get(a.roleId);
        const roleB = this.roles.get(b.roleId);
        const priorityDiff = (roleB?.priority ?? 0) - (roleA?.priority ?? 0);
        if (priorityDiff !== 0) return priorityDiff;
        const scoreDiff = b.score - a.score;
        if (Math.abs(scoreDiff) > Number.EPSILON) return scoreDiff;
        const seniorA = this.agents.get(a.agentId)?.seniority ?? 0;
        const seniorB = this.agents.get(b.agentId)?.seniority ?? 0;
        return seniorB - seniorA;
      });

    const roleHoldCount = new Map<SwarmRoleId, number>();
    const agentRoleCount = new Map<string, number>();
    const agentExclusive = new Set<string>();
    const assignments: RoleAllocation["assignments"] = [];
    const unassigned: SwarmRoleId[] = [];

    const rolesHeldBy = (agentId: string): number => agentRoleCount.get(agentId) ?? 0;

    for (const role of rolesByPriority) {
      const capacity = role.exclusive ? 1 : Math.max(1, role.maxConcurrent);
      let filled = 0;

      for (const pair of ranked) {
        if (pair.roleId !== role.id) continue;
        if (filled >= capacity) break;
        if (agentExclusive.has(pair.agentId)) continue;
        // A saturated agent is skipped outright; a lower-priority role further
        // down the loop will still find it if the cap relaxes next pass.
        if (rolesHeldBy(pair.agentId) >= this.options.maxRolesPerAgent) continue;

        const incumbent = incumbents.get(role.id);
        if (
          incumbent !== undefined &&
          incumbent !== pair.agentId &&
          this.agents.has(incumbent) &&
          !this.isChallenger(pair, incumbent)
        ) {
          // The incumbent retains the role: it is still eligible and no
          // challenger cleared the hysteresis margin.
          const incumbentScore = this.findPair(ranked, incumbent, role.id);
          if (incumbentScore !== null) {
            assignments.push({
              roleId: role.id,
              agentId: incumbent,
              score: incumbentScore,
              incumbent: true,
            });
            filled++;
            roleHoldCount.set(role.id, filled);
            agentRoleCount.set(incumbent, (agentRoleCount.get(incumbent) ?? 0) + 1);
            if (role.exclusive) agentExclusive.add(incumbent);
            continue;
          }
        }

        assignments.push({
          roleId: role.id,
          agentId: pair.agentId,
          score: pair.score,
          incumbent: incumbents.get(role.id) === pair.agentId,
        });
        filled++;
        roleHoldCount.set(role.id, filled);
        agentRoleCount.set(pair.agentId, (agentRoleCount.get(pair.agentId) ?? 0) + 1);
        if (role.exclusive) agentExclusive.add(pair.agentId);
      }

      if (filled === 0) unassigned.push(role.id);
    }

    this.generation++;
    const allocation: RoleAllocation = {
      assignments,
      unassigned,
      scores: pairs,
      computedAt: Date.now(),
      generation: this.generation,
    };
    this.current = allocation;
    return this.cloneAllocation(allocation);
  }

  /** Convenience: who holds `roleId` right now, if anyone. */
  public holderOf(roleId: SwarmRoleId): string | undefined {
    const allocation = this.current;
    if (!allocation) return undefined;
    return allocation.assignments.find((assignment) => assignment.roleId === roleId)?.agentId;
  }

  // ---------------------------------------------------------------- internals

  private findPair(ranked: ScoredPair[], agentId: string, roleId: SwarmRoleId): number | null {
    for (const pair of ranked) {
      if (pair.agentId === agentId && pair.roleId === roleId) return pair.score;
    }
    return null;
  }

  private isChallenger(challenger: ScoredPair, incumbentId: string): boolean {
    const incumbent = this.agents.get(incumbentId);
    if (!incumbent) return true;
    const role = this.roles.get(challenger.roleId);
    if (!role) return false;
    const incumbentPair = this.scorePair(incumbent, role);
    if (!incumbentPair.eligible) return true;
    return challenger.score - incumbentPair.score > this.options.hysteresis;
  }

  private cloneAllocation(allocation: RoleAllocation): RoleAllocation {
    return {
      assignments: allocation.assignments.map((assignment) => ({ ...assignment })),
      unassigned: [...allocation.unassigned],
      scores: allocation.scores.map((score) => ({ ...score, reasons: [...score.reasons] })),
      computedAt: allocation.computedAt,
      generation: allocation.generation,
    };
  }
}
