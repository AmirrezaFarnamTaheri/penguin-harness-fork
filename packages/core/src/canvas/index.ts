/**
 * Canvas math shared with the Web UI: color spaces, vector primitives, viewport culling,
 * bezier curves, node-graph layout and shape rendering.
 *
 * This barrel is the public surface — `packages/web` imports `@prismshadow/penguin-core/canvas`
 * rather than reaching into `core/src/canvas/*` by relative path, which neither the `exports`
 * map nor a published install can satisfy. Add a module here when a second consumer needs it;
 * the deep relative imports are gone and should not come back.
 */

export * from "./color-space.js";
export * from "./vector-primitives.js";
export * from "./viewport-culling.js";
export * from "./bezier-curves.js";
export * from "./node-graph-layout.js";
export * from "./shape-renderers.js";
