/**
 * AST layer — the parser-agnostic IR, the single identity builder, and the grammar-backed
 * parser pool. See parser-pool.ts for the engine-tier contract (ast vs regex fallback).
 */
export * from "./ir.js";
export * from "./fqn.js";
export * from "./parser-pool.js";
