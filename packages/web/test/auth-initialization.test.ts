import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import { authFailureState, isConfirmedUnauthorized } from "../src/state/auth";

describe("initial authentication failure classification", () => {
  it("redirects only after a confirmed unauthorized response", () => {
    expect(isConfirmedUnauthorized(new ApiError(401, "unauthorized", "Not signed in"))).toBe(true);
    expect(isConfirmedUnauthorized(new ApiError(500, "internal", "Restarting"))).toBe(false);
    expect(isConfirmedUnauthorized(new ApiError(0, "network_error", "Offline"))).toBe(false);
    expect(isConfirmedUnauthorized(new TypeError("connection reset"))).toBe(false);
  });

  it("keeps an indeterminate boot retryable after temporary failures", () => {
    expect(authFailureState(undefined, new ApiError(503, "unavailable", "Restarting"))).toEqual({
      user: undefined,
      initializationFailed: true,
    });
    expect(authFailureState(undefined, new ApiError(0, "network_error", "Offline"))).toEqual({
      user: undefined,
      initializationFailed: true,
    });
  });

  it("preserves an authenticated user through a temporary refresh failure", () => {
    const user = {
      userId: "admin",
      isAdmin: true,
      passwordIsInitial: false,
      createdAt: "2026-09-13T00:00:00.000Z",
    };
    expect(authFailureState(user, new ApiError(500, "internal", "Restarting"))).toEqual({
      user,
      initializationFailed: false,
    });
  });

  it("moves any current state to signed out after a confirmed 401", () => {
    expect(authFailureState(undefined, new ApiError(401, "unauthorized", "Expired"))).toEqual({
      user: null,
      initializationFailed: false,
    });
  });
});
