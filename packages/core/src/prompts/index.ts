/**
 * Prompt archaeology, vendor catalog and persona presets.
 *
 * Three layers, in dependency order:
 *  - {@link ./prompt-archaeology.js} — the extraction toolkit: template-literal scanning,
 *    frontmatter round-tripping, injection-marker handling, tool-call format detection,
 *    placeholder interpolation and the token budget constant.
 *  - {@link ./prompt-fingerprint.js} — identity for prompt texts: FNV-1a digest, byte and
 *    token estimates, shingle-based similarity and duplicate detection.
 *  - {@link ./vendor-prompt-catalog.js} — the queryable catalog of shipping prompts,
 *    populated by the four family files ({@link ./anthropic-family.js},
 *    {@link ./ide-family.js}, {@link ./chat-family.js}, {@link ./persona-family.js}).
 *  - {@link ./persona-presets.js} — budget-fitted presets distilled from the catalog.
 *
 * The older `../agent/prompt-catalog.js` and `../agent/persona-masks.js` remain the
 * live registries for their callers; this module supersedes them as the richer catalog
 * but does not re-export from them, so nothing that imports those files changes.
 */

export * from "./prompt-archaeology.js";
export * from "./prompt-fingerprint.js";
export * from "./vendor-prompt-catalog.js";
export * from "./anthropic-family.js";
export * from "./ide-family.js";
export * from "./chat-family.js";
export * from "./persona-family.js";
export * from "./persona-presets.js";
