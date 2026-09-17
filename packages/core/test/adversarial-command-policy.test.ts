import { describe, expect, it } from "vitest";
import type { EnvironmentInterface, LLMInterface } from "../src/interfaces/index.js";
import { withCommandPolicy } from "../src/internal/command-policy.js";
import { assistantText, toolCall, userText } from "../src/omnimessage/index.js";
import type { OmniMessage } from "../src/omnimessage/index.js";
import { Session } from "../src/session.js";

// Literal test data only: no shell, filesystem tool, network, or live model is invoked.
// Path operands below are denied for recursive-force deletion, NOT for escaping a root.
const blockedCommands = [
  "rm -rf /",
  "rm -rf ../outside-fixture",
  "rm -rf ./nested/../../outside-fixture",
  "printf ok; rm -rf /",
  "printf ok && rm -rf /",
  "false || rm -rf /",
  "printf ok | rm -rf /",
  "printf ok\nrm -rf /",
];

const shellArguments = ["cmd", "command", "chars"] as const;

function shellCall(argument: (typeof shellArguments)[number], command: string) {
  return toolCall({
    name: argument === "chars" ? "input_command" : "exec_command",
    arguments: JSON.stringify(
      argument === "chars"
        ? { process_id: "inert-process", chars: `${command}\n` }
        : { [argument]: command },
    ),
    toolCallId: "adversarial-call",
  });
}

// Drive the real Session -> hook -> approval -> engine dispatch seam, with only the
// model and Environment replaced. Even a broken policy can never execute these strings.
async function runSession(call: ReturnType<typeof toolCall>, hookAllows: boolean) {
  let turns = 0;
  let hostCalls = 0;
  let environmentCalls = 0;
  let hookCalls = 0;
  const feedback: OmniMessage[] = [];
  const llm: LLMInterface = {
    async *streamGenerate(params) {
      if (turns++ === 0) {
        yield call;
      } else {
        feedback.push(...params.newMessages);
        yield assistantText("Finished offline fixture.");
      }
      return { status: "completed" };
    },
  };
  const environment: EnvironmentInterface = {
    listTools: async () => [],
    // eslint-disable-next-line require-yield
    async *executeTool() {
      environmentCalls++;
      return { stopReason: "completed" };
    },
    toolPermission: () => undefined,
  };
  const session = new Session({
    meta: {
      session_id: "adversarial-session",
      provider: "custom",
      model_id: "offline-fixture",
      model_context_window: 1000,
      system_prompt: "Offline policy regression fixture.",
      agent_state: process.cwd(),
      workspace: process.cwd(),
    },
    bootstrap: async () => ({ llm }),
    environment,
    imagesDir: process.cwd(),
    modelHasVision: true,
    ...(hookAllows
      ? {
          hooks: {
            preToolUse: [
              {
                name: "allow-all-fixture",
                run: async () => {
                  hookCalls++;
                  return { decision: "allow" as const };
                },
              },
            ],
          },
        }
      : {}),
  });
  const messages: OmniMessage[] = [];
  for await (const message of session.run([userText("Run the offline fixture.")], {
    approve: async () => {
      hostCalls++;
      return "allow";
    },
  })) {
    messages.push(message);
  }
  return { messages, feedback, hostCalls, environmentCalls, hookCalls, turns };
}

for (const hookAllows of [false, true]) {
  describe(`adversarial Session veto (hook allow: ${hookAllows})`, () => {
    for (const argument of shellArguments) {
      it.each(blockedCommands)(`${argument} denies %s before dispatch`, async (command) => {
        const result = await runSession(shellCall(argument, command), hookAllows);
        expect(result.environmentCalls).toBe(0);
        expect(result.hostCalls).toBe(0);
        expect(result.hookCalls).toBe(hookAllows ? 1 : 0);
        expect(result.turns).toBe(2);
        expect(result.messages.map((message) => message.payload)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "approval_decision", decision: "forbidden" }),
            expect.objectContaining({
              type: "tool_call_output",
              tool_call_id: "adversarial-call",
              stop_reason: "aborted",
              output: "Tool call denied by policy.",
            }),
          ]),
        );
        expect(result.feedback.map((message) => message.payload)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "tool_call_output",
              tool_call_id: "adversarial-call",
              output: "Tool call denied by policy.",
            }),
          ]),
        );
      });
    }
  });
}

describe("adversarial policy controls and limits", () => {
  it("dispatches a benign command to the inert Environment (fixture liveness)", async () => {
    const result = await runSession(shellCall("cmd", "printf fixture"), false);
    expect(result.hostCalls).toBe(1);
    expect(result.environmentCalls).toBe(1);
  });

  it.each(shellArguments)("%s still vetoes if the policy source throws", async (argument) => {
    let hostCalls = 0;
    const approve = withCommandPolicy(
      async () => {
        hostCalls++;
        return "allow";
      },
      () => {
        throw new Error("offline policy source unavailable");
      },
    );
    expect(await approve(shellCall(argument, "rm -rf /"))).toBe("forbidden");
    expect(hostCalls).toBe(0);
  });

  it.each(["cat ../outside-fixture.txt", "cat nested/../../outside-fixture.txt"])(
    "does not claim factory path confinement for %s",
    async (command) => {
      // The approval mode / OS confinement must handle paths; the factory command
      // policy does not resolve them. A host denial is preserved, not called a veto.
      let hostCalls = 0;
      const approve = withCommandPolicy(async () => {
        hostCalls++;
        return "deny";
      });
      expect(await approve(shellCall("cmd", command))).toBe("deny");
      expect(hostCalls).toBe(1);
    },
  );
});
