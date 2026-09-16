import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(new URL(`../src/features/${path}`, import.meta.url), "utf8");
describe("work tools truthful state", () => {
  it("never substitutes simulated pipeline execution for a missing response", () => {
    const pipeline = source("pipelines/pipelines-page.tsx");
    expect(pipeline).not.toContain("const mockRun");
    expect(pipeline).not.toContain("Advance to next node locally");
    expect(pipeline).toContain("The server did not return a run");
  });
});
