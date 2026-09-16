/**
 * Live full-run smoke test for the production Agent/Session path.
 *
 * Unlike llm.e2e.test.ts's lower-level GenerativeModel checks, this loads the real default
 * Project config, creates the default Agent and Session without a model override, bootstraps
 * the Session tool/runtime stack, and consumes Session.run() as an actual streamed task.
 *
 * It is opt-in and uses exactly one small live source (the default DeepSeek model) plus one
 * tiny prompt so CI gets a real end-to-end health signal without turning the e2e gate into a
 * benchmark or a material token-cost increase.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createAgent } from "../src/index.js";
import type { OmniMessage } from "../src/omnimessage/index.js";
import { userText } from "../src/omnimessage/index.js";
import { defaultProjectConfig } from "../src/state/project-config.js";

const runLive = process.env.PENGUIN_E2E === "1" && process.env.DEEPSEEK_API_KEY !== undefined;
const maybe = runLive ? it : it.skip;

const payloadType = (message: OmniMessage): string =>
  (message.payload as { type?: string }).type ?? "";

describe(`Agent main-config streamed full-run e2e${runLive ? "" : " (skipped)"}`, () => {
  maybe(
    "loads the default project model and completes a minimal streamed Session.run",
    { timeout: 120_000, retry: 1 },
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-main-config-e2e-"));
      let dispose: (() => void) | undefined;

      try {
        const expectedModel = defaultProjectConfig().default_model;
        expect(expectedModel).toBeDefined();

        const agent = await createAgent({ root });
        // No provider/model override: this is the real default Project config selection path.
        // Disable extended reasoning only to keep the live smoke workload deliberately tiny.
        const session = await agent.createSession({ thinkingLevel: null });
        dispose = () => session.dispose();

        expect(session.provider).toBe(expectedModel!.provider);
        expect(session.modelId).toBe(expectedModel!.model_id);

        const streamed: OmniMessage[] = [];
        const run = session.run(
          [
            userText(
              "Reply with exactly PENGUIN_SMOKE_OK. Do not call tools and do not add explanation.",
            ),
          ],
          {
            // A smoke reply needs no host mutation. If a provider ignores the instruction and
            // asks for a tool anyway, deny it rather than letting the e2e touch the runner host.
            approve: async () => "deny",
          },
        );

        let cutoff: Awaited<ReturnType<typeof run.next>>["value"] | undefined;
        for (;;) {
          const step = await run.next();
          if (step.done) {
            cutoff = step.value;
            break;
          }
          streamed.push(step.value);
        }

        expect(cutoff).toBeNull();
        // Proves Agent/Session bootstrap ran, not just a bare provider request.
        expect(streamed.some((message) => payloadType(message) === "tool_list_ready")).toBe(true);
        expect(streamed.some((message) => payloadType(message) === "request_begin")).toBe(true);

        const completeText = streamed
          .filter((message) => payloadType(message) === "text")
          .map((message) => (message.payload as { text?: string }).text ?? "")
          .join("\n");
        expect(completeText).toContain("PENGUIN_SMOKE_OK");

        const usageMessages = streamed.filter((message) => payloadType(message) === "token_usage");
        expect(usageMessages.length).toBeGreaterThanOrEqual(1);
        const usage = usageMessages.at(-1)!.payload as { request: { total: number } };
        expect(usage.request.total).toBeGreaterThan(0);
      } finally {
        dispose?.();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
