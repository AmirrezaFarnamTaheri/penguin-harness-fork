import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteFile } from "../src/internal/atomic-write.js";

const audit = vi.hoisted(() => ({
  calls: [] as { operation: string; value?: unknown }[],
  failAt: "" as string,
}));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => "fixture-id",
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (file: string, flags: string, mode: number) => {
      audit.calls.push({ operation: "open", value: { flags, mode } });
      const handle = await actual.open(file, flags, mode);
      return {
        writeFile: async (...args: Parameters<typeof handle.writeFile>) => {
          audit.calls.push({ operation: "write" });
          if (audit.failAt === "write") throw new Error("fixture write failure");
          return handle.writeFile(...args);
        },
        chmod: async (bits: number) => {
          audit.calls.push({ operation: "chmod", value: bits });
          if (audit.failAt === "chmod") throw new Error("fixture chmod failure");
          return handle.chmod(bits);
        },
        sync: async () => {
          audit.calls.push({ operation: "sync" });
          if (audit.failAt === "sync") throw new Error("fixture sync failure");
          return handle.sync();
        },
        close: async () => {
          audit.calls.push({ operation: "close" });
          await handle.close();
          if (audit.failAt === "close") throw new Error("fixture close failure");
        },
      };
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      audit.calls.push({ operation: "rename" });
      if (audit.failAt === "rename") throw new Error("fixture rename failure");
      return actual.rename(...args);
    },
  };
});

let directory: string;
let target: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "atomic-security-"));
  target = path.join(directory, "credential");
  audit.calls.length = 0;
  audit.failAt = "";
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("atomic credential write steps", () => {
  it("exclusively creates its temporary file at 0600 before writing any secret", async () => {
    await atomicWriteFile(target, "secret");
    expect(audit.calls[0]).toEqual({ operation: "open", value: { flags: "wx", mode: 0o600 } });
    expect(audit.calls.map((call) => call.operation)).toEqual([
      "open",
      "write",
      "chmod",
      "sync",
      "close",
      "rename",
    ]);
    expect(await readFile(target, "utf8")).toBe("secret");
  });

  it("inherits existing regular-file permissions unless explicitly overridden", async () => {
    await writeFile(target, "old", { mode: 0o640 });
    const previousMode = (await lstat(target)).mode & 0o777;
    await atomicWriteFile(target, "new");
    expect(audit.calls.find((call) => call.operation === "chmod")?.value).toBe(previousMode);
    audit.calls.length = 0;
    await atomicWriteFile(target, "private", { mode: 0o600 });
    expect(audit.calls.find((call) => call.operation === "chmod")?.value).toBe(0o600);
  });

  it("leaves a colliding temporary file untouched on exclusive-create failure", async () => {
    const temporary = path.join(directory, `.credential.tmp-${process.pid}-fixture-id`);
    await writeFile(temporary, "other writer");
    await writeFile(target, "original");
    await expect(atomicWriteFile(target, "replacement")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(temporary, "utf8")).toBe("other writer");
    expect(await readFile(target, "utf8")).toBe("original");
    expect(audit.calls.map((call) => call.operation)).toEqual(["open"]);
  });

  it.each(["write", "chmod", "sync", "close", "rename"])(
    "preserves the original and cleans its own temporary file after %s failure",
    async (operation) => {
      await writeFile(target, "original");
      audit.failAt = operation;
      await expect(atomicWriteFile(target, "replacement")).rejects.toThrow(
        `fixture ${operation} failure`,
      );
      expect(await readFile(target, "utf8")).toBe("original");
      expect(await readdir(directory)).toEqual(["credential"]);
      if (operation !== "rename")
        expect(audit.calls.some((call) => call.operation === "rename")).toBe(false);
    },
  );
});
