/**
 * A spend ceiling that is honest about work already in flight.
 *
 * The naive ceiling — "have we spent more than N dollars yet?" — does not bound anything. Usage
 * for a request is only knowable when the request finishes, so a run with four calls in flight
 * can pass the check four times before the first of them reports anything. A budget that is
 * checked but not enforced this way is a number in a settings page, not a ceiling.
 *
 * So an admitted call RESERVES its cost before it starts, and the reservation is replaced by
 * the actual figure when usage lands. The invariant, which is the whole point:
 *
 *     spent + reserved never exceeds the limit, at any moment, for any interleaving.
 *
 * Two properties that a "just track the total" version gets wrong, both handled here:
 * - settle and cancel are one-shot per call. A usage event delivered twice (a replayed Trace, a
 *   reconnect) releases the reservation once and adds the real cost once; the second delivery
 *   is counted and refused rather than silently doubling the spend or leaking a reservation.
 * - a call that never resolves — the process restarted, the connection dropped, the agent was
 *   aborted — must not hold its reservation forever. The oldest reservations are reclaimed past
 *   a TTL, which is the one way this can under-count, and under-counting is the safe direction:
 *   a reclaimed slot admits one more call than the reservation would have.
 */
export interface SpendCeilingOptions {
  /** Total spend this ceiling allows, in USD. Must be positive. */
  limitUsd: number;
  /** What one call is assumed to cost while in flight. Must be positive. */
  reserveUsd: number;
  /** Injected clock; the TTL below is measured with it. */
  now?: () => number;
  /** How long a reservation may go unresolved before it is reclaimed. */
  reservationTtlMs?: number;
  /** Most reservations held at once; the oldest is evicted past this. */
  maxReservations?: number;
}

export type AdmitResult =
  | { readonly allowed: true; readonly reservationId: string }
  | {
      readonly allowed: false;
      /** Why, in words a reader can act on rather than a bare boolean. */
      readonly reason: string;
      readonly spentUsd: number;
      readonly reservedUsd: number;
      readonly limitUsd: number;
    };

export interface SpendSnapshot {
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly limitUsd: number;
  /** What a new call could reserve right now (0 when the ceiling is reached). */
  readonly availableUsd: number;
  readonly inFlight: number;
  /** Reservations dropped because nothing settled them. */
  readonly reclaimed: number;
}

interface Reservation {
  readonly id: string;
  readonly amountUsd: number;
  readonly startedMs: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_RESERVATIONS = 1000;

export class SpendCeiling {
  private spentUsd = 0;
  private reservations = new Map<string, Reservation>();
  private reclaimedCount = 0;
  private sequence = 0;
  private readonly now: () => number;
  private readonly reservationTtlMs: number;
  private readonly maxReservations: number;

  constructor(private readonly options: SpendCeilingOptions) {
    if (!(options.limitUsd > 0)) throw new Error("limitUsd must be positive");
    if (!(options.reserveUsd > 0)) throw new Error("reserveUsd must be positive");
    this.now = options.now ?? Date.now;
    this.reservationTtlMs = options.reservationTtlMs ?? DEFAULT_TTL_MS;
    this.maxReservations = options.maxReservations ?? DEFAULT_MAX_RESERVATIONS;
  }

  /**
   * Asks whether one more call may start, and reserves for it if so. The reservation is what
   * makes the answer binding: a second caller asking while this one is in flight sees the first
   * one's cost already counted against the limit.
   */
  admit(idHint?: string): AdmitResult {
    this.reclaimExpired();
    if (this.reservations.size >= this.maxReservations) {
      // The oldest reservation is dropped rather than refusing: refusing here would mean an
      // agent that leaked reservations could never call anything again, which is a worse failure
      // than slightly loose accounting.
      const oldest = this.reservations.keys().next().value;
      if (oldest !== undefined) {
        this.reservations.delete(oldest);
        this.reclaimedCount += 1;
      }
    }
    if (this.spentUsd + this.reservedUsd + this.options.reserveUsd > this.options.limitUsd) {
      return {
        allowed: false,
        reason: `spend ceiling reached: ${this.spentUsd.toFixed(4)} spent + ${this.reservedUsd.toFixed(4)} reserved of ${this.options.limitUsd.toFixed(2)}`,
        spentUsd: this.spentUsd,
        reservedUsd: this.reservedUsd,
        limitUsd: this.options.limitUsd,
      };
    }
    this.sequence += 1;
    const id = idHint ?? `reservation-${this.sequence}`;
    this.reservations.set(id, {
      id,
      amountUsd: this.options.reserveUsd,
      startedMs: this.now(),
    });
    return { allowed: true, reservationId: id };
  }

  /**
   * Replaces a reservation with the cost that actually happened. Returns false for an unknown
   * or already-settled reservation, so a duplicated usage event is visible to the caller
   * instead of quietly double-counting the spend.
   */
  settle(reservationId: string, actualUsd: number): boolean {
    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) return false;
    this.reservations.delete(reservationId);
    this.spentUsd += Math.max(0, actualUsd);
    return true;
  }

  /** Releases a reservation for a call that produced no usage (aborted, or never dispatched). */
  cancel(reservationId: string): boolean {
    return this.reservations.delete(reservationId);
  }

  snapshot(): SpendSnapshot {
    this.reclaimExpired();
    return {
      spentUsd: this.spentUsd,
      reservedUsd: this.reservedUsd,
      limitUsd: this.options.limitUsd,
      availableUsd: Math.max(0, this.options.limitUsd - this.spentUsd - this.reservedUsd),
      inFlight: this.reservations.size,
      reclaimed: this.reclaimedCount,
    };
  }

  private get reservedUsd(): number {
    let total = 0;
    for (const reservation of this.reservations.values()) total += reservation.amountUsd;
    return total;
  }

  /**
   * Drops reservations nothing has settled. Under-counting is the safe direction here: a freed
   * slot admits one more call, it never suppresses one.
   */
  private reclaimExpired(): void {
    const now = this.now();
    for (const [id, reservation] of this.reservations) {
      if (now - reservation.startedMs >= this.reservationTtlMs) {
        this.reservations.delete(id);
        this.reclaimedCount += 1;
      }
    }
  }
}
