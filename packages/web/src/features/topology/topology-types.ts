import type {
  CodeGraphNode,
  CodeGraphEdge,
  CodeNodeKind,
  CodeEdgeKind,
} from "@prismshadow/penguin-core";

export type TopologyViewMode = "studio" | "canvas" | "matrix";

export interface TopologyFilterState {
  search: string;
  kind: CodeNodeKind | "all";
  onlyDeadCode: boolean;
  minLoc: number;
}

export interface PathTraceState {
  fromId: string | null;
  toId: string | null;
  path: Array<{ node: CodeGraphNode; edge: CodeGraphEdge | null }> | null;
}

export interface ImpactState {
  focalId: string | null;
  depth: number;
  impactedNodes: CodeGraphNode[];
  impactedEdges: CodeGraphEdge[];
}
