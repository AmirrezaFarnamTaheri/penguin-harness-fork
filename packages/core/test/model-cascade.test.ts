import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgent } from "../src/agent.js";
import { addModel } from "../src/state/project-config.js";
import { KeyRotatorRegistry } from "../src/llm/key-rotator.js";
import { Writer } from "../src/trace/index.js";
import { tracesDir } from "../src/state/paths.js";
import type {
  EnvironmentConfig,
  EnvironmentServices,
  SubagentRunner,
} from "../src/interfaces/index.js";

// Same transparent capture seam as agent.test.ts: all spawning/session assembly is
// real. takeMeta stops before bootstrap, so a test cannot issue an inference call.
const captured = vi.hoisted(() => ({
  services: undefined as EnvironmentServices | undefined,
  toolConfig: undefined as EnvironmentConfig["toolConfig"] | undefined,
}));
vi.mock("../src/environment/index.js", async (original) => {
  const mod = await original<typeof import("../src/environment/index.js")>();
  return {
    ...mod,
    Environment: class extends mod.Environment {
      constructor(config: EnvironmentConfig) {
        super(config);
        captured.services = config.services;
        captured.toolConfig = config.toolConfig;
      }
    },
  };
});
import { ModelComboRegistry, type ModelCombo } from "../src/llm/model-combos.js";

// Explicitly configured references, not guessed vendor/model defaults. Keep frontier
// first to prove routing is by task policy rather than merely array ordering.
const hybrid: ModelCombo = {
  id: "hybrid",
  name: "Local and frontier",
  targets: [
    { provider: "remote", modelId: "configured-frontier", tier: "frontier" },
    { provider: "local", modelId: "configured-small", tier: "local_slm" },
  ],
};

function registry(): ModelComboRegistry {
  return new ModelComboRegistry([hybrid]);
}

describe("configured model cascade routing", () => {
  it("selects the configured local model for file scanning", () => {
    expect(
      registry().resolveCandidate("hybrid", {
        cascade: { taskType: "file_find", failureCount: 0 },
      }),
    ).toEqual(hybrid.targets[1]);
  });

  it("escalates code editing after two task failures", () => {
    const models = registry();
    expect(
      models.resolveCandidate("hybrid", {
        cascade: { taskType: "code_edit", failureCount: 1 },
      }),
    ).toEqual(hybrid.targets[1]);
    expect(
      models.resolveCandidate("hybrid", {
        cascade: { taskType: "code_edit", failureCount: 2 },
      }),
    ).toEqual(hybrid.targets[0]);
  });

  it("routes architecture tasks to frontier and everything else to local", () => {
    expect(
      registry().resolveCandidate("hybrid", {
        cascade: { taskType: "architecture", failureCount: 0 },
      }),
    ).toEqual(hybrid.targets[0]);
    for (const taskType of ["code_edit", "file_find", "unknown", ""]) {
      expect(
        registry().resolveCandidate("hybrid", {
          cascade: { taskType, failureCount: 0 },
        }),
      ).toEqual(hybrid.targets[1]);
    }
  });

  it("falls back to frontier when local is cooling or failed", () => {
    const models = registry();
    expect(
      models.resolveCandidate("hybrid", {
        cascade: { taskType: "file_find", failureCount: 0 },
        coolingModels: new Set(["local:configured-small"]),
      }),
    ).toEqual(hybrid.targets[0]);
    expect(
      models.resolveCandidate("hybrid", {
        cascade: { taskType: "file_find", failureCount: 0 },
        failedTargets: [{ provider: "local", modelId: "configured-small" }],
      }),
    ).toEqual(hybrid.targets[0]);
  });

  it("does not downgrade after escalation if frontier is unavailable", () => {
    expect(
      registry().resolveCandidate("hybrid", {
        cascade: { taskType: "code_edit", failureCount: 2 },
        coolingModels: new Set(["remote:configured-frontier"]),
      }),
    ).toBeUndefined();
  });

  it("preserves ordered fallback when task routing is not requested", () => {
    expect(registry().resolveCandidate("hybrid")).toEqual(hybrid.targets[0]);
    const legacy = new ModelComboRegistry([
      { id: "legacy", name: "Legacy", targets: [{ provider: "p", modelId: "m" }] },
    ]);
    expect(legacy.resolveCandidate("legacy")).toEqual({ provider: "p", modelId: "m" });
  });

  it("does not invent a model when no tier has been configured", () => {
    const models = new ModelComboRegistry([
      { id: "legacy", name: "Legacy", targets: [{ provider: "p", modelId: "m" }] },
    ]);
    expect(
      models.resolveCandidate("legacy", {
        cascade: { taskType: "file_find", failureCount: 0 },
      }),
    ).toBeUndefined();
  });

  it("rejects invalid failure counts rather than silently routing", () => {
    for (const failureCount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        registry().resolveCandidate("hybrid", {
          cascade: { taskType: "file_find", failureCount },
        }),
      ).toThrow("failureCount must be a non-negative safe integer");
    }
  });
});

it.each(["normal-spawn", "resume"] as const)(
  "preserves cascade policy and depth limits through cross-agent %s",
  async (operation) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-cascade-inheritance-"));
    const projectId = `cascade-${operation}`;
    const childAgent = await createAgent({ root, projectId, agentId: "helper" });
    for (const target of hybrid.targets) {
      await addModel(root, projectId, {
        provider: target.provider,
        model_id: target.modelId,
        api_key: "cascade-test-key",
        client_type: "openai-chat",
      });
    }
    const agent = await createAgent({ root, projectId, subagentCascade: hybrid });
    const parent = await agent.createSession({
      workspaceDir: root,
      provider: "remote",
      modelId: "configured-frontier",
      subagentDepth: 0,
    });
    const runner = captured.services!.subagentRunner!;
    try {
      let sessionId: string | undefined;
      if (operation === "resume") {
        const owner = await createAgent({ root, projectId, agentId: childAgent.state.agentId });
        const original = await owner.createSession({
          workspaceDir: root,
          provider: "remote",
          modelId: "configured-frontier",
          source: "subagent",
        });
        try {
          sessionId = original.sessionId;
          // Seed the real resume reader without bootstrapping or making model calls.
          const trace = new Writer({
            tracesDir: tracesDir(root, projectId, childAgent.state.agentId),
            sessionId,
          });
          await trace.write(original.metaMessage);
        } finally {
          original.dispose();
        }
      }
      const child =
        operation === "normal-spawn"
          ? await runner.spawn({ agentId: childAgent.state.agentId })
          : await runner.resume!({ agentId: childAgent.state.agentId, sessionId: sessionId! });
      try {
        expect(child.takeMeta!()?.payload).toMatchObject({
          agent_state: childAgent.state.stateDir,
          provider: "remote",
          model_id: "configured-frontier",
        });
        const childRunner = captured.services!.subagentRunner!;
        const spawnTool = captured.toolConfig!.customTools!.find(
          (tool) => tool.name === "run_subagent",
        );
        if (operation === "normal-spawn") {
          expect(spawnTool).toBeUndefined();
          await expect(
            childRunner.spawn({ cascade: { taskType: "file_find", failureCount: 0 } }),
          ).rejects.toThrow("depth limit");
          return;
        }
        // Revived sessions use the existing resume depth policy (depth zero).
        expect(spawnTool?.parameters?.properties).toMatchObject({
          task_type: { type: "string" },
          failure_count: { type: "integer", minimum: 0 },
        });
        for (const [taskType, provider, modelId] of [
          ["file_find", "local", "configured-small"],
          ["architecture", "remote", "configured-frontier"],
        ] as const) {
          const nested = await childRunner.spawn({ cascade: { taskType, failureCount: 0 } });
          try {
            expect(nested.takeMeta!()?.payload).toMatchObject({
              agent_state: childAgent.state.stateDir,
              provider,
              model_id: modelId,
              source: "subagent",
            });
          } finally {
            nested.dispose();
          }
        }
      } finally {
        child.dispose();
      }
    } finally {
      parent.dispose();
      for (const target of hybrid.targets) {
        KeyRotatorRegistry.reset(`${projectId}/${target.provider}/${target.modelId}`);
      }
    }
  },
);

it("spawns concrete configured child Sessions through the real runner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-cascade-"));
  const initialized = await createAgent({ root });
  const projectId = initialized.state.projectId;
  for (const target of hybrid.targets) {
    await addModel(root, projectId, {
      provider: target.provider,
      model_id: target.modelId,
      api_key: "cascade-test-key",
      client_type: "openai-chat",
    });
  }
  const agent = await createAgent({ root, subagentCascade: hybrid });
  const parent = await agent.createSession({
    workspaceDir: root,
    provider: "remote",
    modelId: "configured-frontier",
  });
  const runner = captured.services!.subagentRunner!;
  async function model(input: Parameters<SubagentRunner["spawn"]>[0]) {
    const handle = await runner.spawn(input);
    try {
      const meta = handle.takeMeta!();
      expect(meta?.payload).toMatchObject({ source: "subagent", workspace: root });
      return meta!.payload;
    } finally {
      handle.dispose();
    }
  }
  try {
    expect(await model({ cascade: { taskType: "file_find", failureCount: 0 } })).toMatchObject({
      provider: "local",
      model_id: "configured-small",
    });
    expect(await model({ cascade: { taskType: "code_edit", failureCount: 2 } })).toMatchObject({
      provider: "remote",
      model_id: "configured-frontier",
    });
    expect(await model({})).toMatchObject({ provider: "remote", model_id: "configured-frontier" });
    expect(
      await model({
        provider: "local",
        modelId: "configured-small",
        cascade: { taskType: "architecture", failureCount: 0 },
      }),
    ).toMatchObject({ provider: "local", model_id: "configured-small" });
    await expect(
      runner.spawn({ provider: "local", cascade: { taskType: "file_find", failureCount: 0 } }),
    ).rejects.toThrow();
    const local = KeyRotatorRegistry.get(`${projectId}/local/configured-small`);
    local.recordFailure("cascade-test-key", "rate_limit", 60_000);
    expect(await model({ cascade: { taskType: "file_find", failureCount: 0 } })).toMatchObject({
      provider: "remote",
      model_id: "configured-frontier",
    });
    const remote = KeyRotatorRegistry.get(`${projectId}/remote/configured-frontier`);
    remote.recordFailure("cascade-test-key", "auth");
    await expect(
      runner.spawn({ cascade: { taskType: "architecture", failureCount: 0 } }),
    ).rejects.toThrow("No available configured cascade model");
  } finally {
    parent.dispose();
    // Only fixture-owned registries are reset; no process-wide clear.
    KeyRotatorRegistry.reset(`${projectId}/local/configured-small`);
    KeyRotatorRegistry.reset(`${projectId}/remote/configured-frontier`);
  }
});
