import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkflowRunState } from "@prismshadow/penguin-core/browser";
import type { PipelineRecord } from "../src/api/endpoints";
import { PipelineStudioCanvas } from "../src/features/pipelines/pipeline-studio-canvas";

const pipeline: PipelineRecord = {
  id: "release",
  name: "Release review",
  nodes: [
    { id: "output", name: "Report", kind: "output" },
    { id: "agent", name: "Architect", kind: "agent", agentRole: "Reviewer" },
    { id: "gate", name: "Approval Gate", kind: "gate" },
    { id: "condition", name: "Check review", kind: "condition" },
    { id: "start", name: "Start", kind: "trigger" },
  ],
  edges: [
    { from: "start", to: "agent" },
    { from: "agent", to: "condition" },
    { from: "condition", to: "gate", conditionValue: true },
    { from: "condition", to: "output", conditionValue: false },
    { from: "gate", to: "output" },
  ],
};
const run: WorkflowRunState = {
  runId: "r1",
  pipelineId: pipeline.id,
  status: "running",
  startedAt: 1,
  currentNodeIds: ["gate"],
  context: {},
  nodeStates: { gate: { nodeId: "gate", status: "waiting_gate" } },
};
const render = (definition = pipeline, state?: WorkflowRunState) =>
  renderToStaticMarkup(
    createElement(PipelineStudioCanvas, {
      pipeline: definition,
      run: state,
      selectedNodeId: "gate",
      onSelectNode: () => {},
    }),
  );

describe("pipeline studio canvas", () => {
  it("renders real workflow kinds, roles, and accessible selectable nodes", () => {
    const html = render();
    expect(html).toContain('aria-label="Workflow graph"');
    expect(html).toContain("Architect");
    expect(html).toContain("Approval Gate");
    expect(html).toContain("Reviewer");
    for (const kind of ["trigger", "agent", "gate", "condition", "output"])
      expect(html).toContain(kind);
    expect(html.match(/role="button"/g)).toHaveLength(5);
    expect(html.match(/tabindex="0"/g)).toHaveLength(5);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it("draws directed saved connections, not adjacent list entries, including false branches", () => {
    const html = render();
    expect(html.match(/data-edge-from=/g)).toHaveLength(5);
    expect(html).toContain('data-edge-from="start" data-edge-to="agent"');
    expect(html).toContain('data-edge-from="condition" data-edge-to="output"');
    expect(html).not.toContain('data-edge-from="output" data-edge-to="agent"');
    expect(html).toContain("marker-end=");
    expect(html).toContain("Check review → Report (false)");
    expect(html).toContain("Check review → Approval Gate (true)");
  });

  it("shows actual run state only for the matching pipeline", () => {
    expect(render(pipeline, run)).toContain("waiting_gate");
    expect(render(pipeline, { ...run, pipelineId: "other" })).not.toContain("waiting_gate");
    expect(render()).not.toContain("running");
  });

  it("has an honest empty state and no invented steps or edges", () => {
    const html = render({ ...pipeline, nodes: [], edges: [] });
    expect(html).toContain("No steps in this workflow.");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain('role="button"');
  });

  it("does not connect disconnected nodes or draw unresolved edges", () => {
    const html = render({ ...pipeline, edges: [{ from: "agent", to: "missing" }] });
    expect(html).not.toContain("data-edge-from=");
    expect(html).toContain("1 unresolved connection not drawn");
    expect(html.match(/role="button"/g)).toHaveLength(5);
  });

  it("keeps long names available without injecting markup", () => {
    const name = "<script>very long workflow step name beyond the visual label</script>";
    const html = render({ ...pipeline, nodes: [{ id: "x", name, kind: "agent" }], edges: [] });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("very long workflow step name beyond the visual label");
  });

  it("gives arrow markers distinct IDs when multiple canvases are rendered", () => {
    const props = { pipeline, selectedNodeId: "", onSelectNode: () => {} };
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(PipelineStudioCanvas, props),
        createElement(PipelineStudioCanvas, props),
      ),
    );
    const ids = [...html.matchAll(/<marker id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
