import { describe, expect, it } from "vitest";
import { toolCall } from "@prismshadow/penguin-core";
import { ApprovalRegistry, makeApprove } from "../src/runtime/approvals.js";

describe("makeApprove", () => {
  it("passes gateway arguments to call-aware permission resolution", async () => {
    const seen: Array<[string, string | undefined]> = [];
    const rawArguments =
      '{"tool_ref":"tr_1","tool_name":"mcp__fx__echo","arguments":{"text":"hi"}}';
    const approve = makeApprove({
      getMode: () => "read-only",
      toolPermission: (name, args) => {
        seen.push([name, args]);
        return "r";
      },
      registry: new ApprovalRegistry(),
      publishRequest: () => {
        throw new Error("read-only gateway calls must not request manual approval");
      },
    });

    const decision = await approve(
      toolCall({ name: "call_tool", arguments: rawArguments, toolCallId: "gateway-1" }),
    );

    expect(decision).toBe("allow");
    expect(seen).toEqual([["call_tool", rawArguments]]);
  });

  it("publishes and replays a trusted gateway approval target", async () => {
    const registry = new ApprovalRegistry();
    const published: Array<ReturnType<typeof registry.list>[number]> = [];
    const approve = makeApprove({
      getMode: () => "always-ask",
      toolPermission: () => "rw",
      toolApprovalTarget: () => ({ name: "mcp__github__create_issue", permission: "rw" }),
      registry,
      publishRequest: (pending) => published.push(pending),
    });
    const pending = approve(
      toolCall({ name: "call_tool", arguments: "{}", toolCallId: "gateway-manual" }),
    );

    expect(published[0]?.approvalTarget).toEqual({
      name: "mcp__github__create_issue",
      permission: "rw",
    });
    expect(registry.list()[0]?.approvalTarget).toEqual(published[0]?.approvalTarget);
    registry.decide("gateway-manual", "deny");
    await expect(pending).resolves.toBe("deny");
  });

  describe("unattended Sessions", () => {
    /** The read-write call that every manual route parks on; an org has nobody to answer it. */
    const writeCall = () =>
      toolCall({ name: "write_file", arguments: "{}", toolCallId: "org-write" });

    it("denies a read-write call outright instead of parking it for a person", async () => {
      const registry = new ApprovalRegistry();
      let published = 0;
      const approve = makeApprove({
        getMode: () => "read-only",
        toolPermission: () => "rw",
        registry,
        unattended: () => true,
        publishRequest: () => {
          published += 1;
        },
      });

      // The whole defect in one assertion: it resolves on its own, without a decide() call
      // that will never come.
      await expect(approve(writeCall())).resolves.toBe("deny");
      expect(published).toBe(0);
      expect(registry.list()).toHaveLength(0);
    });

    it("leaves the automatic answers alone", async () => {
      const modes = ["allow-all", "deny-all"] as const;
      for (const mode of modes) {
        const approve = makeApprove({
          getMode: () => mode,
          toolPermission: () => "rw",
          registry: new ApprovalRegistry(),
          unattended: () => true,
          publishRequest: () => {
            throw new Error(`${mode} never asks anyone`);
          },
        });
        await expect(approve(writeCall())).resolves.toBe(mode === "allow-all" ? "allow" : "deny");
      }
    });

    it("still allows a read tool under read-only", async () => {
      const approve = makeApprove({
        getMode: () => "read-only",
        toolPermission: () => "r",
        registry: new ApprovalRegistry(),
        unattended: () => true,
        publishRequest: () => {
          throw new Error("a read tool under read-only is automatic");
        },
      });
      await expect(approve(writeCall())).resolves.toBe("allow");
    });

    it("parks the same call when nobody is watching for the caller (absent flag)", async () => {
      const registry = new ApprovalRegistry();
      const approve = makeApprove({
        getMode: () => "read-only",
        toolPermission: () => "rw",
        registry,
        publishRequest: () => {},
      });

      // Suspends: still pending, nothing decided. This is the watched-Session behaviour the
      // override must not disturb.
      const pending = approve(writeCall());
      expect(registry.list()).toHaveLength(1);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      registry.decide("org-write", "allow");
      await expect(pending).resolves.toBe("allow");
    });

    it("is read per decision, so a Session that becomes unattended stops parking", async () => {
      const registry = new ApprovalRegistry();
      let unattended = false;
      const approve = makeApprove({
        getMode: () => "read-only",
        toolPermission: () => "rw",
        registry,
        unattended: () => unattended,
        publishRequest: () => {},
      });

      const first = approve(writeCall());
      expect(registry.list()).toHaveLength(1);
      registry.decide("org-write", "allow");
      await expect(first).resolves.toBe("allow");

      // The reconcile pass stamps the row after it is already running.
      unattended = true;
      await expect(approve(writeCall())).resolves.toBe("deny");
      expect(registry.list()).toHaveLength(0);
    });
  });
});
