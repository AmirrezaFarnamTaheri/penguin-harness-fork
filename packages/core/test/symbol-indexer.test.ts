import { describe, expect, it } from "vitest";
import { SymbolIndexer } from "../src/agent/symbol-indexer.js";

describe("SymbolIndexer", () => {
  const indexer = new SymbolIndexer();

  it("tracks columns across a block comment and treats `/*/` as complete", () => {
    // Two defects at once: only newlines advanced `col` inside a block comment, so every
    // token after one was understated by the comment's width; and the closer scan started
    // after the opener, so `/*/` swallowed the rest of the file as an unterminated
    // comment. `tokenize` is public, so both are observable here.
    const tokens = indexer.tokenize("/* a block comment */ const value = 1;\n");
    // `const` sits at column 23 — the pre-fix scanner left `col` near 1 here, because a
    // block comment only advanced `col` on newlines.
    const keyword = tokens.find((token) => token.value === "const");
    expect(keyword).toBeDefined();
    expect(keyword!.line).toBe(1);
    expect(keyword!.column).toBe(23);
    const ident = tokens.find((token) => token.kind === "TIDENT" && token.value === "value");
    expect(ident!.column).toBe(29);

    // `/*/` is a complete empty comment — the `x` after it must still be scanned as an
    // identifier, not absorbed into the comment.
    const afterMinimal = indexer.tokenize("/*/ x = 1;\n");
    expect(afterMinimal.some((token) => token.value === "x")).toBe(true);
  });

  it("parses TypeScript source files correctly", () => {
    const code = `
      import { createHash } from "node:crypto";
      export interface UserConfig { id: string; }
      export type Theme = "light" | "dark";
      export class AgentController {
        run() {}
      }
      export async function executePlan() {}
      export const computeScore = () => 42;
    `;

    const summary = indexer.parseContent("src/agent/controller.ts", code);
    expect(summary.language).toBe("typescript");
    expect(summary.classes).toContain("AgentController");
    expect(summary.interfaces).toContain("UserConfig");
    expect(summary.types).toContain("Theme");
    expect(summary.functions).toContain("executePlan");
    expect(summary.functions).toContain("computeScore");
    expect(summary.imports).toContain("node:crypto");
    expect(summary.exports).toContain("AgentController");
    expect(summary.linesOfCode).toBeGreaterThan(5);
  });

  it("parses Python source files correctly", () => {
    const pyCode = `
      import os
      from pathlib import Path

      class LoopDetector:
          def __init__(self):
              pass

      def check_tool_call(tool_name):
          return True
    `;

    const summary = indexer.parseContent("utils/loop_detector.py", pyCode);
    expect(summary.language).toBe("python");
    expect(summary.classes).toContain("LoopDetector");
    expect(summary.functions).toContain("check_tool_call");
    expect(summary.imports).toContain("os");
    expect(summary.imports).toContain("pathlib");
  });

  it("parses Go and Rust files correctly", () => {
    const goCode = `
      package agent
      import "sync"
      type SessionState struct { ID string }
      type Runner interface { Run() error }
      func NewSession() *SessionState { return nil }
    `;

    const goSummary = indexer.parseContent("pkg/agent/session.go", goCode);
    expect(goSummary.language).toBe("go");
    expect(goSummary.classes).toContain("SessionState");
    expect(goSummary.interfaces).toContain("Runner");
    expect(goSummary.functions).toContain("NewSession");

    const rsCode = `
      use std::sync::Arc;
      pub struct TaskRunner;
      pub trait Executor { fn execute(&self); }
      pub fn start_task() {}
    `;

    const rsSummary = indexer.parseContent("src/task.rs", rsCode);
    expect(rsSummary.language).toBe("rust");
    expect(rsSummary.classes).toContain("TaskRunner");
    expect(rsSummary.interfaces).toContain("Executor");
    expect(rsSummary.functions).toContain("start_task");
  });

  it("identifies code relationships between source and target files", () => {
    const src = indexer.parseContent(
      "src/agent/quota-manager.ts",
      `
        import { QuotaParser } from "./quota-parser";
        export interface QuotaLimit { resetIn: number; }
        export function checkLimit() {}
        export const activeLimits = [];
      `,
    );

    const target = indexer.parseContent(
      "src/server/quota-route.ts",
      `
        import { QuotaLimit, checkLimit } from "../agent/quota-manager";
        export interface QuotaLimit { resetIn: number; }
        export function checkLimit() {}
        export const activeLimits = [];
      `,
    );

    const relationship = indexer.findRelationship(src, target);
    expect(relationship).not.toBeNull();
    expect(relationship?.confidenceScore).toBeGreaterThanOrEqual(0.7);
    expect(relationship?.relationshipType).toBe("direct_match");
    expect(relationship?.helpfulAspects.length).toBeGreaterThan(0);
  });
});
