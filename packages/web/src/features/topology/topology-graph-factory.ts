import { CodeGraph } from "@prismshadow/penguin-core/browser";

/**
 * Compatibility factory for callers that need an empty graph.
 * Repository-specific example nodes are not project evidence and must not be seeded here.
 * The code-structure page loads its graph exclusively from the project's topology endpoint.
 */
export function createPenguinCodeGraph(): CodeGraph {
  return new CodeGraph();
}
