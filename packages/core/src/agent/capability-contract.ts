/**
 * Typed capability contracts — a named tool whitelist an Agent runs under, and the
 * blast-radius tiers between them.
 *
 * A contract is the enforcement shape the approval boundary reads: `assertToolAllowed`
 * answers "may THIS call run under THIS contract" and throws a violation naming the tool
 * and the contract when the answer is no. Contracts are data (like the command policy's
 * rules): a host composes them, stores them, and hands one to a session; the factory tiers
 * here are the standard rungs — `read` < `isolated_write` < `execution` < `full` — ordered
 * by blast radius, not by tool count: each rung adds one capability class (read paths,
 * then workspace writes, then process/network execution, then everything).
 *
 * Deliberately NOT an approval replacement: a contract narrows what a call may even ask
 * about; approval and the command policy still decide what an allowed call may do. An MCP
 * tool not in the contract violates it the same as a builtin — a contract that cannot name
 * a tool cannot vouch for it.
 */
import { EXEC_COMMAND_NAME } from "../environment/tools/exec-command.js";
import { INPUT_COMMAND_NAME } from "../environment/tools/input-command.js";

export type CapabilityContractTier = "read" | "isolated_write" | "execution" | "full";

export interface CapabilityContract {
  name: "ReadContract" | "IsolatedWriteContract" | "ExecutionContract" | "FullContract";
  /** The tier this contract sits at (drives contractFor). */
  tier: CapabilityContractTier;
  /** Tool names the contract permits. FullContract's list is empty because it passes everything. */
  allowedTools: string[];
}

/** Read-only introspection: files, search, listing. No writes, no shell, no network side effects. */
export const READ_ONLY_CONTRACT: CapabilityContract = {
  name: "ReadContract",
  tier: "read",
  allowedTools: ["read_file", "grep_search", "find_by_name", "list_dir", "view_file"],
};

/** Workspace writes without process execution: the file tools only — a content pipe, not an operator. */
export const ISOLATED_WRITE_CONTRACT: CapabilityContract = {
  name: "IsolatedWriteContract",
  tier: "isolated_write",
  allowedTools: [...READ_ONLY_CONTRACT.allowedTools, "write_file", "edit_file"],
};

/** Adds the shell (and its input channel) on top of workspace writes. */
export const EXECUTION_CONTRACT: CapabilityContract = {
  name: "ExecutionContract",
  tier: "execution",
  allowedTools: [...ISOLATED_WRITE_CONTRACT.allowedTools, EXEC_COMMAND_NAME, INPUT_COMMAND_NAME],
};

/** The full surface: every tool passes, including MCP tools the list cannot name. */
export const FULL_CONTRACT: CapabilityContract = {
  name: "FullContract",
  tier: "full",
  allowedTools: [],
};

/** All factory contracts keyed by tier. */
const FACTORY_CONTRACTS: Readonly<Record<CapabilityContractTier, CapabilityContract>> = {
  read: READ_ONLY_CONTRACT,
  isolated_write: ISOLATED_WRITE_CONTRACT,
  execution: EXECUTION_CONTRACT,
  full: FULL_CONTRACT,
};

/**
 * The gate: `toolName` must be a member of `contract.allowedTools` (or the contract is
 * FullContract, which vouches for everything). The error names both the tool and the
 * contract so a denial is diagnosable from the message alone.
 */
export function assertToolAllowed(toolName: string, contract: CapabilityContract): void {
  if (contract.tier === "full") return;
  if (!contract.allowedTools.includes(toolName)) {
    throw new Error(`Tool '${toolName}' violates ${contract.name}`);
  }
}

/** The factory contract for a tier name; undefined for an unknown tier (callers decide what missing means). */
export function contractFor(tier: string): CapabilityContract | undefined {
  return (FACTORY_CONTRACTS as Record<string, CapabilityContract | undefined>)[tier];
}
