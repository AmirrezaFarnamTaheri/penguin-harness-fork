/**
 * Session-level uniqueness for tool_call_id.
 *
 * Some providers don't produce a real call id: e.g. Gemini's functionCall has no id, so AgentHub
 * uses the **function name** as the `tool_call_id` — consecutive/parallel calls to the same tool then
 * all share one id. But the OmniMessage world (engine dispatch/pairing, approval routing, frontend
 * tool-card attribution) keys on `tool_call_id`, and a collision lets a later call overwrite the
 * earlier one (parallel same-name calls in one turn can even be dropped entirely).
 *
 * Approach: inbound, `EventTranslator` disambiguates duplicate ids with a `#n` suffix (the first keeps
 * the original id); outbound (returning tool_result, replaying history on resume) uses
 * `stripToolCallIdSuffix` to strip the suffix and restore the original — Gemini's functionResponse
 * pairs by using `tool_call_id` as the name, so it must be restored to the function name. The registry
 * lives at Session level (the new GenerativeModel rebuilt on compaction shares the same instance), and
 * on resume `setHistory` seeds it with historical ids, so the uniqueness scope covers the entire
 * context the frontend renders.
 * Docs: /docs/interfaces § "The built-in implementation: GenerativeModel".
 */
export class ToolCallIdAllocator {
  /**
   * OmniMessage-level tool_call_ids already taken in this Session (history-seeded + allocated),
   * each tagged with the compaction generation that owns it so retired history can be pruned.
   */
  private readonly used = new Map<string, number>();
  /** Reverse index: an id allocated as `${base}#${n}` maps back to the provider id it came from. */
  private readonly suffixedToBase = new Map<string, number>();
  /** Next candidate suffix per base id, so a repeat allocation never rescans from #2. */
  private readonly nextSuffix = new Map<string, number>();
  private generation = 0;

  /** Ids currently held: history-seeded + allocated, minus the generations `rotate` has retired. */
  get size(): number {
    return this.used.size;
  }

  /** Register an already-used id (for resume seeding); registering twice is harmless. */
  markUsed(id: string): void {
    if (!this.used.has(id)) this.used.set(id, this.generation);
    // Keep the per-base cursor ahead of a suffix an external seeding already reserved.
    const base = baseOfSuffix(id);
    if (base) {
      const next = Number(id.slice(base.length + 1)) + 1;
      if (next > (this.nextSuffix.get(base) ?? 0)) this.nextSuffix.set(base, next);
    }
  }

  /**
   * Allocate a Session-unique id for a provider-reported tool_call_id: if unused, keep the original;
   * if already used (a repeat call from a name-as-id provider), take the first free `origId#n` (n from 2).
   * Providers with truly unique ids (OpenAI `call_*` / Claude `toolu_*`) never collide, so they pass through unchanged.
   */
  allocate(providerId: string): string {
    let id: string;
    if (!this.used.has(providerId)) {
      id = providerId;
    } else {
      let n = this.nextSuffix.get(providerId) ?? 2;
      id = `${providerId}#${n}`;
      while (this.used.has(id)) {
        n += 1;
        id = `${providerId}#${n}`;
      }
      this.nextSuffix.set(providerId, n + 1);
      this.suffixedToBase.set(id, this.generation);
    }
    this.used.set(id, this.generation);
    return id;
  }

  /**
   * Restores the provider id that `allocate` derived `id` from: an id this allocator suffixed maps
   * back to its base, and any other known id is an original returned untouched. Returns `null` when
   * this allocator never saw `id` (e.g. before resume seeding), so the caller can fall back to
   * shape-based stripping.
   */
  originalIdOf(id: string): string | null {
    if (this.suffixedToBase.has(id)) return baseOfSuffix(id) ?? id;
    return this.used.has(id) ? id : null;
  }

  /**
   * Compaction rotation: history the context compactor just retired is gone, so the ids referencing
   * it are released (without this, `used` grows for the whole session). Cohort semantics: only ids
   * from generations strictly older than the one just retired are dropped — the ids seeded or
   * allocated during the generation that just ended still belong to the history that survived the
   * compaction, so they stay and `allocate` cannot hand them out again as a duplicate. The
   * compactor re-seeds the survivors of the compacted context via `markUsed`/`setHistory`
   * immediately afterwards, as it already does on resume.
   */
  rotate(): void {
    const retired = this.generation;
    this.generation += 1;
    for (const [id, gen] of this.used) {
      if (gen < retired) this.used.delete(id);
    }
    for (const [id, gen] of this.suffixedToBase) {
      if (gen < retired) this.suffixedToBase.delete(id);
    }
    for (const base of this.nextSuffix.keys()) {
      if (!this.suffixedToBaseHas(base)) this.nextSuffix.delete(base);
    }
  }

  /** Whether any held id still belongs to `base` (used to retire a stale suffix cursor). */
  private suffixedToBaseHas(base: string): boolean {
    for (const [id] of this.used) {
      if (id === base || (id.startsWith(`${base}#`) && /^\d+$/.test(id.slice(base.length + 1)))) {
        return true;
      }
    }
    return false;
  }
}

/** The base id of a `${base}#${digits}` form, or null when `id` is not that shape. */
function baseOfSuffix(id: string): string | null {
  const hash = id.lastIndexOf("#");
  if (hash <= 0) return null;
  return /^\d+$/.test(id.slice(hash + 1)) ? id.slice(0, hash) : null;
}

/**
 * Strip the `#n` suffix added by `allocate`, restoring the provider's original id (returns as-is when
 * there's no suffix; idempotent).
 *
 * When the allocator is available it is authoritative: only ids it actually suffixed are trimmed, so
 * a provider id that legitimately ends in `#2` round-trips intact instead of being restored to a
 * different id than the registry allocated. Without one (resume, before seeding) it trims by shape:
 * real ids from known providers (OpenAI/Claude `call_*`/`toolu_*`, Gemini function names — `#` isn't
 * a valid function-name char) never end in `#<digits>`, so they aren't harmed.
 */
export function stripToolCallIdSuffix(id: string, allocator?: ToolCallIdAllocator): string {
  if (allocator) {
    const resolved = allocator.originalIdOf(id);
    if (resolved !== null) return resolved;
  }
  return id.replace(/#\d+$/, "");
}
