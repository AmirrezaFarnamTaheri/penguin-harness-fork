import { readFileSync } from "node:fs";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { toolCall } from "@prismshadow/penguin-core";
import { ApprovalRegistry, makeApprove } from "../../server/src/runtime/approvals";
import { ApprovalButtons } from "../src/features/chat/approval-buttons";
import { ToolBreakpointPanel } from "../src/features/cockpit/tool-breakpoint-panel";
import type { PendingApproval } from "../src/lib/omni/stream-controller";
import { S } from "../src/lib/strings";

const pending: PendingApproval = {
  toolCall: toolCall({
    name: "exec_command",
    arguments: '{"cmd":"git push origin main","workdir":"project","description":"Inspect status"}',
    toolCallId: "call-1",
  }),
};

describe("tool breakpoint panel", () => {
  it("is mounted on the real origin-scoped tool card and uses the existing decision callback", () => {
    const source = readFileSync(
      new URL("../src/features/chat/tool-call-card.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("ctx.pendingApprovals.get(approvalKey(ctx.origin, item.toolCallId))");
    expect(source).toContain("<ToolBreakpointPanel");
    expect(source).toContain("pending={pending}");
    expect(source).toContain("ctx.onApprove(item.toolCallId, decision, ctx.origin)");
    expect(source).toContain("pending.toolCall.payload.arguments");
  });

  it("preserves child-origin pending approvals across the main task boundary and denies on interruption", async () => {
    const registry = new ApprovalRegistry();
    const child = { ...pending.toolCall, origin: ["child-session"] };
    const result = registry.wait(child);
    registry.denyMain();
    expect(registry.list()[0]?.origin).toEqual(["child-session"]);
    registry.denyAll();
    await expect(result).resolves.toBe("deny");
    expect(registry.size).toBe(0);
  });

  it("does not offer a pending breakpoint for automatically denied calls", async () => {
    const registry = new ApprovalRegistry();
    const approve = makeApprove({
      getMode: () => "deny-all",
      toolPermission: () => "rw",
      registry,
      publishRequest: () => {
        throw new Error("Denied calls must not ask for approval");
      },
    });
    await expect(approve(pending.toolCall)).resolves.toBe("deny");
    expect(registry.size).toBe(0);
  });

  it("renders the actual call, every argument, and only supported decisions", () => {
    const html = renderToStaticMarkup(
      createElement(ToolBreakpointPanel, {
        pending,
        onDecide: async () => {},
      }),
    );
    expect(html).toContain("exec_command");
    expect(html).toContain("git push origin main");
    expect(html).toContain("workdir");
    expect(html).toContain(S.chat.approvalWaiting);
    expect(html).toContain(S.chat.approve);
    expect(html).toContain(S.chat.deny);
    expect(html.match(/<button\b/g)).toHaveLength(2);
    expect(html).not.toContain("truncate");
  });

  it("shows the trusted gateway target and renders malformed JSON as inert text", () => {
    const html = renderToStaticMarkup(
      createElement(ToolBreakpointPanel, {
        pending: {
          ...pending,
          toolCall: toolCall({
            name: "call_tool",
            arguments: "<script>alert(1)</script>{",
            toolCallId: "gateway",
          }),
          approvalTarget: { name: "mcp__github__create_issue", permission: "rw" },
        },
        onDecide: async () => {},
      }),
    );
    expect(html).toContain("call_tool");
    expect(html).toContain("mcp__github__create_issue (rw)");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders nothing once the pending request disappears", () => {
    expect(
      renderToStaticMarkup(
        createElement(ToolBreakpointPanel, {
          pending: undefined,
          onDecide: async () => {},
        }),
      ),
    ).toBe("");
  });

  it.each(["allow", "deny"] as const)(
    "forwards %s from the existing controls to the real pending registry",
    async (decision) => {
      const registry = new ApprovalRegistry();
      const requests: PendingApproval[] = [];
      const approve = makeApprove({
        getMode: () => "always-ask",
        toolPermission: () => "rw",
        registry,
        publishRequest: (request) => requests.push(request),
      });
      const result = approve(pending.toolCall);
      expect(registry.size).toBe(1);
      const panel = ToolBreakpointPanel({
        pending: requests[0],
        onDecide: async (answer) => {
          expect(registry.decide(pending.toolCall.payload.tool_call_id, answer)).toBe(true);
        },
      });
      if (!panel) throw new Error("Missing pending panel");
      const controls = panel.props.children.find(
        (child: unknown) => isValidElement(child) && child.type === ApprovalButtons,
      );
      if (!isValidElement<{ onDecide: (answer: "allow" | "deny") => Promise<void> }>(controls)) {
        throw new Error("Missing approval controls");
      }
      await controls.props.onDecide(decision);
      await expect(result).resolves.toBe(decision);
      expect(registry.size).toBe(0);
      expect(registry.decide("call-1", decision)).toBe(false);
    },
  );
});
