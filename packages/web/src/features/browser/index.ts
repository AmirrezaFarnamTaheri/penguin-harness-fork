/**
 * Barrel for the cockpit browser widgets — the Tier 3 view onto the steerable cluster's live
 * telemetry. A page composes these from the cluster event stream; each widget takes already-
 * decoded contract data as props and owns no socket of its own.
 */
export * from "./live-browser-viewport.js";
export * from "./dom-tree-inspector.js";
export * from "./network-harvester-card.js";
