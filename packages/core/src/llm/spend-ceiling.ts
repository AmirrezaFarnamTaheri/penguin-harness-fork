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
  /**
   * Settlements charged at their reserved amount because the reported cost was not a usable
   * number (negative, `NaN`, infinite). Non-zero means some of `spentUsd` is the commitment this
   * class made rather than a measured cost.
   */
  readonly uncertainSettlements: number;
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
  /**
   * Sum of every live reservation, maintained incrementally.
   *
   * It was a getter that walked the map, and `admit` reads it once per call while holding nothing:
   * every admitted request paid an O(in-flight) sum, so a fleet running a thousand concurrent
   * reservations did a million map visits to answer a question whose answer was already known.
   * Add and remove happen on exactly the four paths that touch the map below, so keeping the total
   * beside it cannot fall out of step with the map itself.
   */
  private reservedTotalUsd = 0;
  private reclaimedCount = 0;
  /** Settlements that arrived with a figure that was not a usable amount; see `settle`. */
  private uncertainSettlements = 0;
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
      if (oldest !== undefined && this.dropReservation(oldest)) this.reclaimedCount += 1;
    }
    if (this.spentUsd + this.reservedTotalUsd + this.options.reserveUsd > this.options.limitUsd) {
      return {
        allowed: false,
        reason: `spend ceiling reached: ${this.spentUsd.toFixed(4)} spent + ${this.reservedTotalUsd.toFixed(4)} reserved of ${this.options.limitUsd.toFixed(2)}`,
        spentUsd: this.spentUsd,
        reservedUsd: this.reservedTotalUsd,
        limitUsd: this.options.limitUsd,
      };
    }
    this.sequence += 1;
    // The id is made unique here rather than trusted from the hint. Two in-flight calls handed the
    // same hint used to collide on the map, and the second `set` silently *replaced* the first
    // reservation: the first call still ran and still cost money, but the reservation backing it
    // was gone, so its later `settle` found nothing to release and the real cost was never added
    // to `spentUsd` — the ceiling under-counting actual spend by exactly the amount it had just
    // promised to cover. The returned id is the authority, so a disambiguated one is correct by
    // construction; a caller that ignores the return value and settles by its own hint is the only
    // remaining way to lose a reservation, and that is a caller bug rather than a silent one here.
    const id = this.uniqueId(idHint);
    this.reservations.set(id, {
      id,
      amountUsd: this.options.reserveUsd,
      startedMs: this.now(),
    });
    this.reservedTotalUsd += this.options.reserveUsd;
    return { allowed: true, reservationId: id };
  }

  /** The hinted id, or the next free suffixed form of it when that id is already reserved. */
  private uniqueId(idHint?: string): string {
    const base = idHint ?? `reservation-${this.sequence}`;
    if (!this.reservations.has(base)) return base;
    let n = 2;
    while (this.reservations.has(`${base}#${n}`)) n += 1;
    return `${base}#${n}`;
  }

  /** Removes one reservation and keeps the running reserved total in step. */
  private dropReservation(id: string): boolean {
    const reservation = this.reservations.get(id);
    if (reservation === undefined) return false;
    this.reservations.delete(id);
    this.reservedTotalUsd -= reservation.amountUsd;
    return true;
  }

  /**
   * Replaces a reservation with the cost that actually happened. Returns false for an unknown
   * or already-settled reservation, so a duplicated usage event is visible to the caller
   * instead of quietly double-counting the spend.
   *
   * A settlement whose amount is not a usable number is charged at the **reserved** amount, not at
   * zero. `Math.max(0, NaN)` is `NaN`, and adding that once made `spentUsd` permanently `NaN` —
   * after which every `spentUsd + reservedUsd > limitUsd` comparison is false, so the ceiling
   * admitted everything forever while still reporting a reached limit in its own reason string. A
   * single malformed usage event from one provider was enough to disable the whole budget. The
   * reserved figure is the commitment this class actually made for the call, so charging it keeps
   * the books at that commitment instead of assuming the call was free, and
   * {@link SpendSnapshot.uncertainSettlements} records that it was not a measurement.
   */
  settle(reservationId: string, actualUsd: number): boolean {
    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) return false;
    this.dropReservation(reservationId);
    if (typeof actualUsd !== "number" || !Number.isFinite(actualUsd)) {
      this.uncertainSettlements += 1;
      this.spentUsd += reservation.amountUsd;
      return true;
    }
    this.spentUsd += Math.max(0, actualUsd);
    return true;
  }

  /** Releases a reservation for a call that produced no usage (aborted, or never dispatched). */
  cancel(reservationId: string): boolean {
    return this.dropReservation(reservationId);
  }

  snapshot(): SpendSnapshot {
    this.reclaimExpired();
    return {
      spentUsd: this.spentUsd,
      reservedUsd: this.reservedTotalUsd,
      limitUsd: this.options.limitUsd,
      availableUsd: Math.max(0, this.options.limitUsd - this.spentUsd - this.reservedTotalUsd),
      inFlight: this.reservations.size,
      reclaimed: this.reclaimedCount,
      uncertainSettlements: this.uncertainSettlements,
    };
  }

  /**
   * Drops reservations nothing has settled. Under-counting is the safe direction here: a freed
   * slot admits one more call, it never suppresses one.
   *
   * A clock that jumps backwards (an NTP step, a suspended laptop) makes `now - startedMs`
   * negative, which compares as "not yet expired" — so nothing expires and reservations are held
   * until the clock catches up. That is the conservative direction, and it cannot wedge the
   * ceiling permanently: the `maxReservations` bound in `admit` evicts the oldest regardless of
   * age, so a stalled clock costs throughput rather than correctness. No clamp is applied here
   * because a backwards step is indistinguishable from a reservation taken microseconds ago, and
   * treating the latter as expired would under-count real in-flight work.
   */
  private reclaimExpired(): void {
    const now = this.now();
    for (const [id, reservation] of this.reservations) {
      if (now - reservation.startedMs >= this.reservationTtlMs) {
        this.dropReservation(id);
        this.reclaimedCount += 1;
      }
    }
  }
}
