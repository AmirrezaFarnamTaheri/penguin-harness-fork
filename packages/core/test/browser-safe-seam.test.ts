import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../src/browser.ts", import.meta.url));

describe("browser-safe core seam", () => {
  it("bundles the complete browser entry without external modules and evaluates without Node globals", async () => {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "PenguinBrowser",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(result.outputFiles).toHaveLength(1);
    for (const output of Object.values(result.metafile.outputs)) {
      expect(output.imports).toEqual([]);
    }
    const code = result.outputFiles[0]!.text;
    expect(
      runInNewContext(
        `${code}\n[typeof PenguinBrowser.ShellGuardian, typeof PenguinBrowser.QuorumConsensusEngine, typeof PenguinBrowser.CodeGraph]`,
        {},
        { timeout: 1000 },
      ),
    ).toEqual(["function", "function", "function"]);
  });

  it.each(["node:fs", "node:child_process", "fs", "child_process"])(
    "rejects an accidental runtime dependency on %s rather than externalizing it",
    async (dependency) => {
      await expect(
        build({
          stdin: { contents: `export * from ${JSON.stringify(dependency)};` },
          bundle: true,
          platform: "browser",
          write: false,
          logLevel: "silent",
        }),
      ).rejects.toThrow(/Could not resolve/);
    },
  );
});
