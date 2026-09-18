import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUTHORITATIVE_PROVENANCE,
  CAPABILITY_TABLE,
  SAFE_ENV_KEYS,
  SandboxPolicyBox,
  SecurityViolationError,
  instructionAuthority,
} from "../../src/sandbox/sandbox-policy-box.js";
import type {
  InstructionProvenance,
  SecurityViolation,
} from "../../src/sandbox/sandbox-policy-box.js";

/** The box is a process singleton, so every test starts and ends with a clean one. */
function freshBox(): SandboxPolicyBox {
  SandboxPolicyBox.resetInstance();
  return SandboxPolicyBox.getInstance();
}

/** Resolve after a tick, so an async context has to survive an await to be observed. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("sandbox-policy-box", () => {
  beforeEach(() => SandboxPolicyBox.resetInstance());
  afterEach(() => SandboxPolicyBox.resetInstance());

  describe("capability table", () => {
    it("denies every declared capability by default", () => {
      // The table's own strategies are the deny-by-default property: nothing is
      // permitted unless a preset or an explicit override says so.
      for (const entry of CAPABILITY_TABLE) {
        expect(entry.strategy).toBe("deny");
        expect(entry.name.length).toBeGreaterThan(0);
        expect(entry.reason.length).toBeGreaterThan(0);
      }
    });

    it("carries the safe environment keys Node's own internals read", () => {
      expect(SAFE_ENV_KEYS.has("NODE_ENV")).toBe(true);
      expect(SAFE_ENV_KEYS.has("VITEST_WORKER_ID")).toBe(true);
      // A user secret is not on the list.
      expect(SAFE_ENV_KEYS.has("OPENAI_API_KEY")).toBe(false);
      const envEntry = CAPABILITY_TABLE.find((entry) => entry.name === "process:env");
      expect(envEntry?.allowedKeys).toBe(SAFE_ENV_KEYS);
    });
  });

  describe("capability decisions", () => {
    it("denies a requested capability outside a sandbox context without recording", () => {
      const box = freshBox();
      const decision = box.decide("shell:exec");
      expect(decision.outcome).toBe("deny");
      expect(decision.violationType).toBe("shell_exec");
      expect(decision.reason).toContain("shell command");
      expect(box.getStats().violationsRecorded).toBe(0);
    });

    it("permits a capability configured on the box", async () => {
      const box = SandboxPolicyBox.getInstance({ capabilities: ["shell:exec"] });
      expect(box.getStats().permitted).toEqual(["shell:exec"]);
      const handle = box.activate();
      await handle.run(async () => {
        expect(box.decide("shell:exec").outcome).toBe("permit");
      });
      handle.deactivate();
    });

    it("permits a specific key of a denied capability via the key list", async () => {
      const box = freshBox();
      const handle = box.activate();
      await handle.run(async () => {
        expect(box.decide("process:env", "NODE_ENV").outcome).toBe("permit");
        expect(() => box.decide("process:env", "OPENAI_API_KEY")).toThrow(SecurityViolationError);
      });
      handle.deactivate();
    });

    it("permits a keyed capability declared as capability:key", async () => {
      const box = SandboxPolicyBox.getInstance({ capabilities: ["process:env:CUSTOM_KEY"] });
      const handle = box.activate();
      await handle.run(async () => {
        expect(box.decide("process:env", "CUSTOM_KEY").outcome).toBe("permit");
        expect(() => box.decide("process:env", "OTHER_KEY")).toThrow(SecurityViolationError);
      });
      handle.deactivate();
    });

    it("audits a capability whose violation type is excluded from denial", async () => {
      const box = SandboxPolicyBox.getInstance({ excludeViolationTypes: ["shell_exec"] });
      const handle = box.activate();
      await handle.run(async () => {
        const decision = box.decide("shell:exec");
        expect(decision.outcome).toBe("audit");
        expect(decision.reason).toContain("excluded");
        // An exclusion is not a permission, so nothing is recorded.
        expect(box.getStats().violationsRecorded).toBe(0);
      });
      handle.deactivate();
    });

    it("treats an undeclared capability as a denial", () => {
      const box = freshBox();
      const decision = box.decide("syscall:frobnicate");
      expect(decision.outcome).toBe("deny");
      expect(decision.violationType).toBe("capability_not_declared");
      // Unlike a known-but-denied capability, an undeclared one is recorded even
      // outside a sandbox context, because the request itself is the signal.
      const violation = box.getStats().violations[0];
      expect(violation?.type).toBe("capability_not_declared");
      expect(violation?.path).toBe("syscall:frobnicate");
    });

    it("refuses an undeclared capability inside a sandbox context", async () => {
      const box = freshBox();
      const handle = box.activate();
      await handle.run(async () => {
        expect(() => box.decide("syscall:frobnicate")).toThrow(SecurityViolationError);
      });
      handle.deactivate();
    });
  });

  describe("violation taxonomy", () => {
    it("records and surfaces a violation through SecurityViolationError", async () => {
      const box = freshBox();
      const handle = box.activate();
      await handle.run(async () => {
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
        let caught: SecurityViolationError | undefined;
        try {
          box.decide("shell:exec");
        } catch (error) {
          caught = error as SecurityViolationError;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught?.name).toBe("SecurityViolationError");
        // The typed violation is what an audit log filters by.
        const violation = caught?.violation;
        expect(violation?.type).toBe("shell_exec");
        expect(violation?.path).toBe("shell:exec");
        expect(violation?.message).toContain("shell:exec");
        expect(violation?.executionId).toBe(handle.executionId);
        expect(typeof violation?.timestamp).toBe("number");
        expect(typeof violation?.stack).toBe("string");
        expect(box.getStats().violationsRecorded).toBe(2);
      });
      handle.deactivate();
    });

    it("attributes each violation to its own execution", async () => {
      const box = freshBox();
      const handle = box.activate();
      await handle.run(async () => {
        expect(SandboxPolicyBox.getCurrentExecutionId()).toBe(handle.executionId);
        try {
          box.decide("fs:write");
        } catch {
          // expected
        }
        const violation = box.getStats().violations[0];
        expect(violation?.type).toBe("filesystem_write_outside_root");
        expect(violation?.executionId).toBe(handle.executionId);
      });
      handle.deactivate();
      expect(SandboxPolicyBox.getCurrentExecutionId()).toBeUndefined();
    });

    it("returns a copy of the recorded violations", () => {
      const box = freshBox();
      box.recordViolation("eval", "eval", "recorded");
      const first = box.getStats().violations;
      const second = box.getStats().violations;
      expect(second).not.toBe(first);
      expect(second).toEqual(first);
    });

    it("caps the recorded buffer so a hostile workload cannot exhaust memory", () => {
      const box = freshBox();
      for (let index = 0; index < 1100; index += 1) {
        box.recordViolation("eval", "eval", `attempt ${index}`);
      }
      expect(box.getStats().violationsRecorded).toBe(1000);
    });

    it("clears recorded violations", () => {
      const box = freshBox();
      box.recordViolation("eval", "eval", "recorded");
      expect(box.getStats().violationsRecorded).toBe(1);
      box.clearViolations();
      expect(box.getStats().violationsRecorded).toBe(0);
    });

    it("invokes the observer for every violation in blocking mode", async () => {
      const observed: SecurityViolation[] = [];
      const box = SandboxPolicyBox.getInstance({
        onViolation: (violation) => observed.push(violation),
      });
      const handle = box.activate();
      await handle.run(async () => {
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
      });
      handle.deactivate();
      expect(observed).toHaveLength(1);
      expect(observed[0]?.type).toBe("shell_exec");
    });

    it("does not let a throwing observer suppress the denial", async () => {
      const box = SandboxPolicyBox.getInstance({
        onViolation: () => {
          throw new Error("observer is down");
        },
      });
      const handle = box.activate();
      await handle.run(async () => {
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
        expect(box.getStats().violationsRecorded).toBe(1);
      });
      handle.deactivate();
    });
  });

  describe("audit mode", () => {
    it("records violations without denying them", async () => {
      const box = SandboxPolicyBox.getInstance({ auditMode: true });
      expect(box.getStatus().auditMode).toBe(true);
      // Auditing is observation, not protection.
      expect(box.getStatus().level).toBe("none");
      const handle = box.activate();
      await handle.run(async () => {
        expect(box.decide("shell:exec").outcome).toBe("audit");
        expect(box.decide("network:outbound").outcome).toBe("audit");
        expect(box.getStats().violationsRecorded).toBe(2);
      });
      handle.deactivate();
    });

    it("reports an undeclared capability as audit rather than deny", async () => {
      const box = SandboxPolicyBox.getInstance({ auditMode: true });
      const handle = box.activate();
      await handle.run(async () => {
        expect(box.decide("syscall:frobnicate").outcome).toBe("audit");
      });
      handle.deactivate();
    });
  });

  describe("scoped activation", () => {
    it("blocks only inside the sandbox async context", async () => {
      const box = freshBox();
      const handle = box.activate();
      // Outside the handle, the same call is a harmless verdict.
      expect(box.decide("shell:exec").outcome).toBe("deny");
      expect(SandboxPolicyBox.isInSandboxedContext()).toBe(false);

      await handle.run(async () => {
        expect(SandboxPolicyBox.isInSandboxedContext()).toBe(true);
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
        // The context survives an await.
        await tick();
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
      });

      expect(SandboxPolicyBox.isInSandboxedContext()).toBe(false);
      expect(box.decide("shell:exec").outcome).toBe("deny");
      handle.deactivate();
    });

    it("does not leak the context into concurrent host work", async () => {
      const box = freshBox();
      const handle = box.activate();
      const sandboxBranch = handle.run(async () => {
        await tick(5);
        return SandboxPolicyBox.isInSandboxedContext();
      });
      const hostBranch = (async () => {
        await tick(5);
        return SandboxPolicyBox.isInSandboxedContext();
      })();
      const [sandboxResult, hostResult] = await Promise.all([sandboxBranch, hostBranch]);
      expect(sandboxResult).toBe(true);
      expect(hostResult).toBe(false);
      handle.deactivate();
    });

    it("reference counts nested activations and fails safe on an unbalanced deactivate", () => {
      const box = freshBox();
      const first = box.activate();
      const second = box.activate();
      expect(box.isActive()).toBe(true);
      expect(box.getStats().refCount).toBe(2);

      first.deactivate();
      expect(box.getStats().refCount).toBe(1);
      expect(box.isActive()).toBe(true);
      // A forgetful caller leaves the box on — the safe direction to fail in.
      second.deactivate();
      second.deactivate();
      expect(box.getStats().refCount).toBe(0);
      expect(box.isActive()).toBe(false);
      // The clamped count means a later activation still installs protection.
      const third = box.activate();
      expect(box.getStats().refCount).toBe(1);
      third.deactivate();
    });

    it("keeps the shared context blocking after a sibling handle deactivates", async () => {
      const box = freshBox();
      const first = box.activate();
      const second = box.activate();
      first.deactivate();
      await second.run(async () => {
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
      });
      second.deactivate();
    });

    it("accumulates active time across activations", async () => {
      const box = freshBox();
      expect(box.getStats().activeTimeMs).toBe(0);
      const handle = box.activate();
      await handle.run(async () => {
        await tick(15);
      });
      handle.deactivate();
      expect(box.getStats().activeTimeMs).toBeGreaterThan(0);
    });

    it("refuses to run new work on a deactivated handle", async () => {
      const box = freshBox();
      const handle = box.activate();
      handle.deactivate();
      await expect(handle.run(async () => "done")).rejects.toThrow(/deactivated/);
    });

    it("hands out a context-free handle when the box is disabled", async () => {
      const box = SandboxPolicyBox.getInstance(false);
      expect(box.getStatus().state).toBe("disabled");
      expect(box.getStatus().level).toBe("none");
      const handle = box.activate();
      await handle.run(async () => {
        expect(SandboxPolicyBox.isInSandboxedContext()).toBe(false);
        expect(box.decide("shell:exec").outcome).toBe("deny");
      });
      handle.deactivate();
      await expect(handle.run(async () => "done")).rejects.toThrow(/deactivated/);
    });

    it("refuses a config change while protection is active", async () => {
      const box = freshBox();
      const handle = box.activate();
      expect(() => box.updateConfig({ auditMode: true })).toThrow(
        /cannot change while protection is active/,
      );
      expect(box.getStatus().auditMode).toBe(false);
      handle.deactivate();
    });

    it("applies a config change only to future activations", async () => {
      const box = freshBox();
      const first = box.activate();
      await first.run(async () => {
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
      });
      first.deactivate();

      box.updateConfig({ capabilities: ["shell:exec"] });
      expect(box.getStats().permitted).toEqual(["shell:exec"]);

      const second = box.activate();
      await second.run(async () => {
        expect(box.decide("shell:exec").outcome).toBe("permit");
      });
      second.deactivate();
    });
  });

  describe("trusted scopes", () => {
    it("runTrusted suspends denial for infrastructure code", async () => {
      const box = freshBox();
      const handle = box.activate();
      await handle.run(async () => {
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
        const decision = await SandboxPolicyBox.runTrusted(async () => {
          await tick();
          // The trusted scope suspends enforcement: no throw, and nothing recorded.
          return box.decide("shell:exec");
        });
        // The verdict itself is unchanged — trusted scope lifts the denial, not the
        // policy decision, which stays "deny" unless the capability is configured.
        expect(decision.outcome).toBe("deny");
        expect(box.getStats().violationsRecorded).toBe(1);
        // Denial is restored once the trusted scope has left.
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
      });
      handle.deactivate();
    });

    it("runTrusted cleans up after a synchronous function", async () => {
      const box = freshBox();
      const handle = box.activate();
      await handle.run(async () => {
        const decision = SandboxPolicyBox.runTrusted(() => box.decide("shell:exec"));
        expect(decision.outcome).toBe("deny");
        expect(box.getStats().violationsRecorded).toBe(0);
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
      });
      handle.deactivate();
    });

    it("runTrusted cleans up when the trusted function rejects", async () => {
      const box = freshBox();
      const handle = box.activate();
      await handle.run(async () => {
        await expect(
          SandboxPolicyBox.runTrusted(async () => {
            await tick();
            throw new Error("infrastructure blew up");
          }),
        ).rejects.toThrow(/infrastructure blew up/);
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
      });
      handle.deactivate();
    });

    it("runTrusted is a no-op outside a sandbox context", () => {
      const box = freshBox();
      expect(SandboxPolicyBox.isInSandboxedContext()).toBe(false);
      expect(SandboxPolicyBox.runTrusted(() => box.decide("shell:exec").outcome)).toBe("deny");
    });

    it("runUntrustedAsync restores denial inside trusted host code", async () => {
      const box = freshBox();
      const handle = box.activate();
      await handle.run(async () => {
        await SandboxPolicyBox.runTrusted(async () => {
          expect(box.decide("shell:exec").outcome).toBe("deny");
          await SandboxPolicyBox.runUntrustedAsync(async () => {
            expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
          });
          // The untrusted window ended, so the trusted scope is in force again.
          expect(box.decide("shell:exec").outcome).toBe("deny");
        });
      });
      handle.deactivate();
    });

    it("keeps one sandbox's trusted scope from lifting another's denial", async () => {
      const box = freshBox();
      const first = box.activate();
      const second = box.activate();

      let enteredTrustedScope = false;
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      const firstRun = first.run(async () =>
        SandboxPolicyBox.runTrusted(async () => {
          enteredTrustedScope = true;
          await released;
        }),
      );

      // The trusted scope is entered synchronously by runTrusted, so by the time
      // this line runs the first execution is trusted and parked on the gate.
      expect(enteredTrustedScope).toBe(true);

      await second.run(async () => {
        // The depth counter is per executionId, so the second sandbox is still denied.
        expect(() => box.decide("shell:exec")).toThrow(SecurityViolationError);
      });

      release();
      await firstRun;
      first.deactivate();
      second.deactivate();
    });
  });

  describe("instructionAuthority", () => {
    it("allows only live-user content to carry instructions", () => {
      expect([...AUTHORITATIVE_PROVENANCE]).toEqual(["live-user"]);
      expect(instructionAuthority("live-user")).toEqual({ allowed: true });
    });

    it.each(["stored-content", "compaction-summary", "external-content"] as const)(
      "refuses %p",
      (provenance: InstructionProvenance) => {
        const decision = instructionAuthority(provenance);
        expect(decision.allowed).toBe(false);
        if (decision.allowed) return; // narrows the union for the type checker
        expect(decision.violationType).toBe("untrusted_instruction_acted_on");
        expect(decision.reason.length).toBeGreaterThan(0);
      },
    );

    it("gives each refused provenance class its own stated reason", () => {
      const stored = instructionAuthority("stored-content");
      expect(stored.allowed).toBe(false);
      if (!stored.allowed) {
        expect(stored.reason).toContain("stored task content is untrusted");
      }
      const compaction = instructionAuthority("compaction-summary");
      expect(compaction.allowed).toBe(false);
      if (!compaction.allowed) {
        expect(compaction.reason).toContain("historical note");
      }
      const external = instructionAuthority("external-content");
      expect(external.allowed).toBe(false);
      if (!external.allowed) {
        expect(external.reason).toContain("untrusted");
      }
    });
  });

  describe("singleton", () => {
    it("returns the same instance for an identical config", () => {
      const first = SandboxPolicyBox.getInstance({ capabilities: ["shell:exec"] });
      const second = SandboxPolicyBox.getInstance({ capabilities: ["shell:exec"] });
      expect(second).toBe(first);
    });

    it("rejects an incompatible downgrade config", () => {
      SandboxPolicyBox.getInstance({ capabilities: ["shell:exec"], auditMode: false });
      // A weaker first caller must not downgrade protection for a later one.
      expect(() => SandboxPolicyBox.getInstance({ capabilities: [] })).toThrow(/config conflict/);
      expect(() => SandboxPolicyBox.getInstance({ capabilities: ["shell:exec"] })).not.toThrow();
    });

    it("rejects a config that weakens audit mode", () => {
      SandboxPolicyBox.getInstance({ auditMode: true });
      expect(() => SandboxPolicyBox.getInstance({ auditMode: false })).toThrow(/config conflict/);
    });

    it("rejects a config with a different violation callback", () => {
      SandboxPolicyBox.getInstance({ onViolation: () => undefined });
      expect(() => SandboxPolicyBox.getInstance({ onViolation: () => undefined })).toThrow(
        /config conflict/,
      );
    });

    it("resetInstance clears the singleton for a new config", () => {
      SandboxPolicyBox.getInstance({ capabilities: ["shell:exec"] });
      SandboxPolicyBox.resetInstance();
      const after = SandboxPolicyBox.getInstance({ capabilities: [] });
      expect(after.getStats().permitted).toEqual([]);
    });
  });
});
