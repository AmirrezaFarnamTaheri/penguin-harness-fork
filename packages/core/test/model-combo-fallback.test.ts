/**
 * Fallback routing over a configured model combo (ModelComboRegistry).
 *
 * The combo's target list is an ordered cascade: the first candidate is preferred, and
 * escalation happens only when a concrete failure rules it out — a target already recorded
 * as failed, or one currently cooling down after a rate limit. This pins that routing
 * decision itself: which target is selected after a failure, and that no target is ever
 * re-selected after it has been ruled out (escalation is sticky — the registry returns
 * nothing rather than downgrade back to a target that already failed).
 *
 * `shouldTriggerFallback` is the escalation trigger: a detected failure reason escalates only
 * when the combo allows it, so a combo can opt out of cascading on reasons it considers
 * recoverable in place.
 */
import { describe, expect, it } from "vitest";
import {
  ModelComboRegistry,
  type ComboResolutionContext,
  type ModelCombo,
} from "../src/llm/index.js";

// Explicitly configured references, not guessed vendor/model defaults. Keep the frontier
// first to prove routing is by failure, not merely array ordering.
const hybrid: ModelCombo = {
  id: "hybrid",
  name: "Local and frontier",
  targets: [
    { provider: "remote", modelId: "configured-frontier" },
    { provider: "local", modelId: "configured-small" },
  ],
};

function registry(): ModelComboRegistry {
  return new ModelComboRegistry([hybrid]);
}

describe("configured model combo fallback routing", () => {
  it("selects the first configured target when nothing has failed", () => {
    expect(registry().resolveCandidate("hybrid")).toEqual(hybrid.targets[0]);
    expect(registry().resolveCandidate("hybrid", {})).toEqual(hybrid.targets[0]);
  });

  it("escalates to the next target after a recorded failure", () => {
    const models = registry();
    expect(
      models.resolveCandidate("hybrid", {
        failedTargets: [{ provider: "remote", modelId: "configured-frontier" }],
      }),
    ).toEqual(hybrid.targets[1]);
    // A failed target with only a reason still counts as ruled out.
    expect(
      models.resolveCandidate("hybrid", {
        failedTargets: [
          { provider: "remote", modelId: "configured-frontier", reason: "rate_limit" },
        ],
      }),
    ).toEqual(hybrid.targets[1]);
  });

  it("escalates away from a target that is still cooling down", () => {
    expect(
      registry().resolveCandidate("hybrid", {
        coolingModels: new Set(["remote:configured-frontier"]),
      }),
    ).toEqual(hybrid.targets[1]);
  });

  it("never re-selects a ruled-out target: no downgrade after escalation", () => {
    const models = registry();
    // The frontier failed and the local fallback is cooling: nothing is eligible, and the
    // registry does not fall back to the failed frontier to have something to return.
    expect(
      models.resolveCandidate("hybrid", {
        failedTargets: [{ provider: "remote", modelId: "configured-frontier" }],
        coolingModels: new Set(["local:configured-small"]),
      }),
    ).toBeUndefined();
    // Every target failed: no candidate, not a repeat of an earlier one.
    expect(
      models.resolveCandidate("hybrid", {
        failedTargets: hybrid.targets.map((target) => ({
          provider: target.provider,
          modelId: target.modelId,
        })),
      }),
    ).toBeUndefined();
  });

  it("does not invent a model for an unknown combo or an empty target list", () => {
    expect(registry().resolveCandidate("nope")).toBeUndefined();
    const empty = new ModelComboRegistry([{ id: "empty", name: "Empty", targets: [] }]);
    expect(
      empty.resolveCandidate("empty", {
        failedTargets: [{ provider: "remote", modelId: "configured-frontier" }],
      }),
    ).toBeUndefined();
  });

  it("resolves a fresh clone, so routing decisions never mutate the registry", () => {
    const models = registry();
    const context: ComboResolutionContext = {
      failedTargets: [{ provider: "remote", modelId: "configured-frontier" }],
    };
    const resolved = models.resolveCandidate("hybrid", context)!;
    expect(resolved).toEqual(hybrid.targets[1]);
    // Mutating the resolution or the context does not feed back into later resolutions.
    resolved.provider = "mutated";
    context.failedTargets!.push({ provider: "local", modelId: "configured-small" });
    expect(models.resolveCandidate("hybrid")).toEqual(hybrid.targets[0]);
    expect(models.get("hybrid")!.targets[0]).toEqual(hybrid.targets[0]);
  });
});

describe("combo escalation triggers", () => {
  it("escalates on the default failure reasons without extra configuration", () => {
    const models = registry();
    const combo = models.get("hybrid")!;
    expect(
      models.shouldTriggerFallback(combo, { isQuota: true, isAuthenticationFailure: false }),
    ).toBe(true);
    expect(
      models.shouldTriggerFallback(combo, {
        isQuota: false,
        isAuthenticationFailure: true,
        isOverloaded: true,
      }),
    ).toBe(true);
    expect(
      models.shouldTriggerFallback(combo, { isQuota: false, isAuthenticationFailure: false }),
    ).toBe(false);
    // An idle timeout escalates even though it carries no detection fields.
    expect(
      models.shouldTriggerFallback(combo, { isQuota: false, isAuthenticationFailure: false }, true),
    ).toBe(true);
  });

  it("classifies legacy code/reason text so older detections still route correctly", () => {
    const models = registry();
    const combo = models.get("hybrid")!;
    expect(
      models.shouldTriggerFallback(combo, {
        isQuota: false,
        isAuthenticationFailure: false,
        code: 503,
        reason: "Service unavailable",
      }),
    ).toBe(true);
    // The legacy text is still classified as a context-length failure, but that reason is not
    // one of the default triggers, so the default combo holds its target rather than cascade.
    expect(
      models.shouldTriggerFallback(combo, {
        isQuota: false,
        isAuthenticationFailure: false,
        reason: "context_length_exceeded",
      }),
    ).toBe(false);
  });

  it("only escalates on the reasons a combo explicitly allows", () => {
    const models = new ModelComboRegistry([
      {
        ...hybrid,
        id: "strict",
        fallbackTriggers: ["context_length_exceeded"],
      },
    ]);
    const combo = models.get("strict")!;
    // A rate limit is not an allowed trigger for this combo: hold the target in place.
    expect(
      models.shouldTriggerFallback(combo, { isQuota: true, isAuthenticationFailure: false }),
    ).toBe(false);
    expect(
      models.shouldTriggerFallback(combo, {
        isQuota: false,
        isAuthenticationFailure: false,
        isContextLengthExceeded: true,
      }),
    ).toBe(true);
    // An empty trigger list opts the combo out of cascading entirely.
    const frozen = new ModelComboRegistry([{ ...hybrid, id: "frozen", fallbackTriggers: [] }]).get(
      "frozen",
    )!;
    expect(
      models.shouldTriggerFallback(frozen, { isQuota: true, isAuthenticationFailure: false }),
    ).toBe(false);
  });
});
