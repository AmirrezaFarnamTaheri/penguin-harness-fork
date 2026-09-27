import { JevClient } from "./client.js";
import { JevToolAdvisor } from "./advisor.js";

/**
 * Host-composition options for the optional Jev advisor.
 *
 * This object is supplied by the embedding process, never read from
 * Agent-writable `system_config.yaml`: an Agent must not be able to redirect a
 * host-owned credential to an endpoint it chooses.
 */
export interface CreateJevAdvisorOptions {
  /** Host-owned credential. It is never placed in Agent State or a trace event. */
  apiKey: string;
  /** Optional host-controlled API root, primarily for a trusted local provider or test double. */
  baseUrl?: string;
  model?: string;
  /** Per-attempt SDK timeout. */
  timeoutMs?: number;
  /** Maximum SDK retries after the first attempt. */
  maxRetries?: number;
  /** Hard wall-clock budget for the advisor call, including retries. */
  deadlineMs?: number;
  /**
   * Explicit host opt-in to argument-value egress. Recognized credential shapes
   * are scrubbed, but opaque values remain the host's explicit data-egress choice.
   */
  includeArguments?: boolean;
  fetch?: typeof fetch;
}

/** Creates the opt-in advisor owned by the host/application composition layer. */
export function createJevAdvisor(options: CreateJevAdvisorOptions): JevToolAdvisor {
  const client = new JevClient({
    apiKey: options.apiKey,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.deadlineMs !== undefined ? { totalTimeoutMs: options.deadlineMs } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  return new JevToolAdvisor({
    client,
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    ...(options.includeArguments !== undefined
      ? { includeArguments: options.includeArguments }
      : {}),
  });
}
