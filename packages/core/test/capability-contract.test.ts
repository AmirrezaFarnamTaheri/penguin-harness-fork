import { describe, expect, it } from "vitest";
import {
  EXECUTION_CONTRACT,
  FULL_CONTRACT,
  ISOLATED_WRITE_CONTRACT,
  READ_ONLY_CONTRACT,
  assertToolAllowed,
  contractFor,
} from "../src/agent/capability-contract.js";

describe("capability contracts", () => {
  it("forbids a write tool under ReadContract with a named violation", () => {
    expect(() => assertToolAllowed("write_file", READ_ONLY_CONTRACT)).toThrowError(
      /Tool 'write_file' violates ReadContract/,
    );
  });

  it("allows exactly the contract's own tools under ReadContract", () => {
    for (const tool of READ_ONLY_CONTRACT.allowedTools) {
      expect(() => assertToolAllowed(tool, READ_ONLY_CONTRACT)).not.toThrow();
    }
    expect(assertToolAvailable("exec_command", READ_ONLY_CONTRACT)).toBe(false);
  });

  it("lets FullContract pass every tool, known or not", () => {
    expect(() => assertToolAllowed("write_file", FULL_CONTRACT)).not.toThrow();
    expect(() => assertToolAllowed("anything_mcp", FULL_CONTRACT)).not.toThrow();
  });

  it("draws the write/execute boundary per contract", () => {
    // IsolatedWrite may edit files but never reach a shell or the network.
    expect(() => assertToolAllowed("write_file", ISOLATED_WRITE_CONTRACT)).not.toThrow();
    expect(() => assertToolAllowed("edit_file", ISOLATED_WRITE_CONTRACT)).not.toThrow();
    expect(() => assertToolAllowed("exec_command", ISOLATED_WRITE_CONTRACT)).toThrowError(
      /violates IsolatedWriteContract/,
    );
    // Execution adds the shell on top of workspace writes: both file writes and the shell pass there.
    expect(() => assertToolAllowed("exec_command", EXECUTION_CONTRACT)).not.toThrow();
    expect(() => assertToolAllowed("write_file", EXECUTION_CONTRACT)).not.toThrow();
    // The ladder is cumulative in one direction only: what Read allows, Execution allows;
    // what Execution allows, Full allows — and Read allows neither writes nor shell.
    expect(() => assertToolAllowed("write_file", READ_ONLY_CONTRACT)).toThrowError(
      /violates ReadContract/,
    );
    expect(() => assertToolAllowed("exec_command", READ_ONLY_CONTRACT)).toThrowError(
      /violates ReadContract/,
    );
  });

  it("resolves a contract by tier name", () => {
    expect(contractFor("read")?.name).toBe("ReadContract");
    expect(contractFor("full")?.name).toBe("FullContract");
    expect(contractFor("nonsense")).toBeUndefined();
  });
});

/** Local helper: boolean form of the same gate, for readability in assertions. */
function assertToolAvailable(toolName: string, contract: Parameters<typeof assertToolAllowed>[1]) {
  try {
    assertToolAllowed(toolName, contract);
    return true;
  } catch {
    return false;
  }
}
