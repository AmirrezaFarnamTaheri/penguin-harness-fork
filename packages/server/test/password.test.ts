/**
 * Unit tests for scrypt password hashing: format, verification, salt randomness,
 * and fallback behavior for invalid stored strings. These call `hashPassword` without a
 * cost argument, so they are the one place the production work factor is exercised.
 */
import { describe, expect, it } from "vitest";
import {
  SCRYPT_COST,
  checkPassword,
  hashPassword,
  verifyAccountPassword,
  verifyPassword,
} from "../src/auth/password.js";
import type { PasswordCheck } from "../src/auth/password.js";

describe("password", () => {
  it("hash format is scrypt$N$r$p$salt$hash and verifies", async () => {
    const stored = await hashPassword("hello-world-123");
    const parts = stored.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    // The default work factor is what production hashes at; `hashPassword`'s cost argument
    // exists for the test suite and must never lower what an unparameterized call writes.
    expect(SCRYPT_COST).toBe(16384);
    expect(Number(parts[1])).toBe(SCRYPT_COST);
    await expect(verifyPassword("hello-world-123", stored)).resolves.toBe(true);
  });

  it("a wrong password fails verification", async () => {
    const stored = await hashPassword("correct-password");
    await expect(verifyPassword("wrong-password", stored)).resolves.toBe(false);
  });

  it("hashing the same password twice differs (random salt)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    await expect(verifyPassword("same-password", a)).resolves.toBe(true);
    await expect(verifyPassword("same-password", b)).resolves.toBe(true);
  });

  it("invalid stored strings return false instead of throwing", async () => {
    await expect(verifyPassword("x", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("x", "bcrypt$a$b$c$d$e")).resolves.toBe(false);
    await expect(verifyPassword("x", "scrypt$abc$8$1$!!$!!")).resolves.toBe(false);
  });
});

describe("checkPassword", () => {
  it("reports match, mismatch and unverifiable as three distinct outcomes", async () => {
    const stored = await hashPassword("correct-password");
    await expect(checkPassword("correct-password", stored)).resolves.toBe("match");
    await expect(checkPassword("wrong-password", stored)).resolves.toBe("mismatch");
  });

  it("classifies every unusable stored string as unverifiable, never throwing", async () => {
    for (const stored of [
      "",
      "not-a-hash",
      "bcrypt$a$b$c$d$e",
      "scrypt$abc$8$1$c2FsdA$aGFzaA", // non-integer cost
      "scrypt$16384$8$1$$", // empty salt and hash
      // Node rejects a cost below the interactive bound synchronously; the stored string is
      // well-formed, so only the derivation itself reveals that it cannot be checked.
      "scrypt$3$8$1$c2FsdA$aGFzaA",
    ]) {
      await expect(checkPassword("x", stored)).resolves.toBe("unverifiable");
    }
  });
});

describe("verifyAccountPassword", () => {
  /**
   * Counts scrypt derivations by delegating to the real check. `checkPassword` returns
   * `match`/`mismatch` exactly when it derived and `unverifiable` when it did not, so the
   * outcome — not the invocation — is what a derivation costs.
   */
  function countingCheck(counter: { derivations: number; derivedAgainst: string[] }) {
    return async (password: string, stored: string): Promise<PasswordCheck> => {
      const outcome = await checkPassword(password, stored);
      if (outcome !== "unverifiable") {
        counter.derivations += 1;
        counter.derivedAgainst.push(stored);
      }
      return outcome;
    };
  }

  it("a real account costs one derivation, against its own hash, and verifies", async () => {
    const stored = await hashPassword("correct-password");
    const counter = { derivations: 0, derivedAgainst: [] as string[] };
    const dummy = async () => {
      throw new Error("a real account must never need the dummy hash");
    };
    await expect(
      verifyAccountPassword("correct-password", stored, dummy, countingCheck(counter)),
    ).resolves.toBe(true);
    expect(counter.derivedAgainst).toEqual([stored]);
  });

  it("an unknown account costs one derivation, against the dummy, and fails", async () => {
    const dummyHash = await hashPassword("a-password-nobody-holds");
    const counter = { derivations: 0, derivedAgainst: [] as string[] };
    await expect(
      verifyAccountPassword("anything", null, async () => dummyHash, countingCheck(counter)),
    ).resolves.toBe(false);
    expect(counter.derivedAgainst).toEqual([dummyHash]);
  });

  it("a wrong password on a real account is one derivation and fails", async () => {
    const stored = await hashPassword("correct-password");
    const counter = { derivations: 0, derivedAgainst: [] as string[] };
    await expect(
      verifyAccountPassword(
        "wrong-password",
        stored,
        async () => {
          throw new Error("a checkable hash must never need the dummy hash");
        },
        countingCheck(counter),
      ),
    ).resolves.toBe(false);
    expect(counter.derivedAgainst).toEqual([stored]);
  });

  it("an unverifiable stored hash falls back to the dummy rather than skipping the work", async () => {
    const dummyHash = await hashPassword("a-password-nobody-holds");
    for (const stored of ["", "not-a-hash", "scrypt$3$8$1$c2FsdA$aGFzaA"]) {
      const counter = { derivations: 0, derivedAgainst: [] as string[] };
      // The real password must not verify through the dummy: the outcome is false regardless.
      await expect(
        verifyAccountPassword(
          "correct-password",
          stored,
          async () => dummyHash,
          countingCheck(counter),
        ),
      ).resolves.toBe(false);
      // The stored string was never derived against; only the dummy was.
      expect(counter.derivedAgainst).toEqual([dummyHash]);
    }
  });

  it("every call derives exactly once, so duration cannot distinguish the two failures", async () => {
    const stored = await hashPassword("correct-password");
    const dummyHash = await hashPassword("a-password-nobody-holds");
    const cases: Array<[string, string | null]> = [
      ["wrong-password", stored],
      ["wrong-password", null],
      ["wrong-password", ""],
      ["wrong-password", "not-a-hash"],
      ["correct-password", null], // a correct password for an account that does not exist
    ];
    for (const [password, hash] of cases) {
      const counter = { derivations: 0, derivedAgainst: [] as string[] };
      await expect(
        verifyAccountPassword(password, hash, async () => dummyHash, countingCheck(counter)),
      ).resolves.toBe(false);
      expect(counter.derivations).toBe(1);
    }
  });
});
