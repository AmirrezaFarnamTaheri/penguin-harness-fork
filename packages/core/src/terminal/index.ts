/**
 * Terminal primitives shared with the Web UI: ANSI color handling, the block model,
 * command history, and unified-diff hunk staging.
 *
 * This barrel is the public surface — `packages/web` imports
 * `@prismshadow/penguin-core/terminal` rather than reaching into `core/src/terminal/*` by
 * relative path, which neither the `exports` map nor a published install can satisfy.
 */

export * from "./ansi-color.js";
export * from "./block-model.js";
export * from "./command-history.js";
export * from "./hunk-staging.js";
