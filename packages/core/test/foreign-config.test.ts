/**
 * H1 — foreign-configuration ownership and transaction contract.
 *
 * The fixture matrix the card asks for: a managed config, an unmanaged one, an unsupported
 * version, a file edited between preview and apply (twice, at both check points), a permission
 * denial, a failed rename, a symlink whose chain does not terminate, and byte-exact restore after
 * each of them. Every refusal asserts the same two things: the typed code, and that the original
 * bytes on disk are untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const fault = vi.hoisted(() => ({ renameCode: "" as string }));

// Failure injection for the one stage a test cannot reach through the filesystem: a rename that
// fails after the backup exists. Everything else uses real files and real permissions.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fault.renameCode !== "") {
        const error = new Error(
          `fixture: rename refused (${fault.renameCode})`,
        ) as NodeJS.ErrnoException;
        error.code = fault.renameCode;
        throw error;
      }
      return actual.rename(...args);
    },
  };
});

import {
  backupPathFor,
  jsonConfigAdapter,
  previewForeignConfig,
  applyForeignConfig,
  adoptForeignConfig,
  restoreForeignConfig,
  redactValue,
  PROJECT_CONFIG_ADAPTER,
} from "../src/state/foreign-config.js";

const adapter = jsonConfigAdapter({
  id: "demo-provider",
  markerKey: "penguinManaged",
  markerValue: "true",
  versionKey: "configVersion",
  supportedVersions: { min: 1, max: 1 },
});

let directory: string;
let configPath: string;
let backupDirectory: string;

const MANAGED = `${JSON.stringify(
  {
    penguinManaged: "true",
    configVersion: 1,
    endpoint: "https://old.example",
    apiKey: "sk-live-abcd1234",
  },
  null,
  2,
)}\n`;
const UNMANAGED = `${JSON.stringify({ endpoint: "https://foreign.example", apiKey: "sk-other-9999" }, null, 2)}\n`;

async function write(content: string, file = configPath): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return content;
}

const shaOf = async (file: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(await readFile(file, "utf8"))
    .digest("hex");
};

const modeOf = async (file: string): Promise<number> => (await stat(file)).mode & 0o777;

const backupsIn = async (): Promise<string[]> =>
  (await readdir(backupDirectory)).filter((name) => name.includes(".penguin-backup-"));

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "foreign-config-"));
  backupDirectory = await mkdtemp(path.join(tmpdir(), "foreign-backups-"));
  configPath = path.join(directory, "settings.json");
  fault.renameCode = "";
});

afterEach(async () => {
  fault.renameCode = "";
  await rm(directory, { recursive: true, force: true });
  await rm(backupDirectory, { recursive: true, force: true });
});

describe("H1.1 — ownership, version, and the preview record", () => {
  it("records bytes, hash, permissions, version and managed ownership at preview", async () => {
    await write(MANAGED);
    await chmod(configPath, 0o640);
    const expectedMode = await modeOf(configPath);
    const result = await previewForeignConfig(configPath, adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { preview } = result;
    expect(preview.adapterId).toBe("demo-provider");
    expect(preview.bytes).toBe(Buffer.byteLength(MANAGED, "utf8"));
    expect(preview.sha256).toBe(await shaOf(configPath));
    expect(preview.mode).toBe(expectedMode);
    expect(preview.mtimeMs).toBeGreaterThan(0);
    expect(preview.version).toBe(1);
    expect(preview.marker).toBe("true");
    expect(preview.isManagedProvider).toBe(true);
    expect(preview.isRegularFile).toBe(true);
    expect(preview.symlink).toBeNull();
  });

  it("marks a file without the marker as unmanaged rather than guessing", async () => {
    await write(UNMANAGED);
    const result = await previewForeignConfig(configPath, adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.isManagedProvider).toBe(false);
    expect(result.preview.marker).toBeNull();
    expect(result.diagnostics.join(" ")).toContain("not a symlink");
  });

  it("reports a missing file as an empty, unmanaged preview instead of an error", async () => {
    const result = await previewForeignConfig(configPath, adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.bytes).toBe(0);
    expect(result.preview.isManagedProvider).toBe(false);
    expect(result.preview.isRegularFile).toBe(false);
    expect(result.diagnostics.join(" ")).toContain("does not exist yet");
  });
});

describe("H1.2 — the transaction", () => {
  it("backs up, writes atomically, reads back redacted, and names every stage", async () => {
    const before = await write(MANAGED);
    await chmod(configPath, 0o640);
    const expectedMode = await modeOf(configPath);
    const preview = await previewForeignConfig(configPath, adapter);
    if (!preview.ok) throw new Error("expected a preview");

    const result = await applyForeignConfig(configPath, adapter, {
      patch: { endpoint: "https://new.example", apiKey: "sk-live-zzzz9999" },
      expectedSha256: preview.preview.sha256,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);

    expect(result.stages).toEqual(["inspect", "gate", "backup", "write", "readback"]);
    expect(result.beforeSha256).toBe(preview.preview.sha256);
    expect(result.afterSha256).toBe(await shaOf(configPath));
    // The backup holds the original bytes exactly, at the mode the original had.
    expect(await readFile(result.backupPath, "utf8")).toBe(before);
    expect(await modeOf(result.backupPath)).toBe(expectedMode);
    // The new file keeps the mode too, and carries the patch plus the marker/version.
    expect(await modeOf(configPath)).toBe(expectedMode);
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(written.endpoint).toBe("https://new.example");
    expect(written.configVersion).toBe(1);
    expect(written.penguinManaged).toBe("true");
    // Redacted readback: the secret's last four characters, never the value.
    expect(result.readback.endpoint).toBe("https://new.example");
    expect(result.readback.apiKey).toBe("****9999");
    expect(JSON.stringify(result.readback)).not.toContain("sk-live-zzzz9999");
    expect(result.version).toBe(1);
  });

  it("treats a write that does not read back as a failure and restores the original", async () => {
    const before = await write(MANAGED);
    const preview = await previewForeignConfig(configPath, adapter);
    if (!preview.ok) throw new Error("expected a preview");
    // A lying adapter: it claims to write the marker and then does not. The readback gate is the
    // only thing standing between this and a config the Harness would refuse to touch next time.
    const lyingAdapter = {
      ...adapter,
      compose: (text: string) =>
        `${JSON.stringify({ endpoint: "https://no-marker.example" }, null, 2)}\n`,
    };
    const result = await applyForeignConfig(configPath, lyingAdapter, {
      patch: { endpoint: "https://no-marker.example" },
      expectedSha256: preview.preview.sha256,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("readback-mismatch");
    expect(result.failedAt).toBe("readback");
    expect(result.stages).toContain("restore");
    expect(result.originalPreserved).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("refuses to write an unmanaged file and leaves it alone", async () => {
    const before = await write(UNMANAGED);
    const preview = await previewForeignConfig(configPath, adapter);
    if (!preview.ok) throw new Error("expected a preview");
    const result = await applyForeignConfig(configPath, adapter, {
      patch: { endpoint: "https://new.example" },
      expectedSha256: preview.preview.sha256,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unmanaged-provider");
    expect(result.failedAt).toBe("gate");
    expect(result.originalPreserved).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await backupsIn()).toEqual([]);
  });

  it("refuses a version outside the supported range", async () => {
    const future = `${JSON.stringify({ penguinManaged: "true", configVersion: 2, endpoint: "x" }, null, 2)}\n`;
    const before = await write(future);
    const preview = await previewForeignConfig(configPath, adapter);
    if (!preview.ok) throw new Error("expected a preview");
    const result = await applyForeignConfig(configPath, adapter, {
      patch: { endpoint: "https://new.example" },
      expectedSha256: preview.preview.sha256,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported-version");
    expect(result.message).toContain("1-1");
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("refuses a file that changed since the preview, keeping the other writer's bytes", async () => {
    await write(MANAGED);
    const preview = await previewForeignConfig(configPath, adapter);
    if (!preview.ok) throw new Error("expected a preview");
    const external = `${JSON.stringify(
      { penguinManaged: "true", configVersion: 1, endpoint: "https://external.example" },
      null,
      2,
    )}\n`;
    await write(external);

    const result = await applyForeignConfig(configPath, adapter, {
      patch: { endpoint: "https://ours.example" },
      expectedSha256: preview.preview.sha256,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("changed-since-preview");
    expect(result.failedAt).toBe("gate");
    expect(await readFile(configPath, "utf8")).toBe(external);
    expect(await backupsIn()).toEqual([]);
  });

  it("refuses a change that lands between the gate and the rename", async () => {
    await write(MANAGED);
    const preview = await previewForeignConfig(configPath, adapter);
    if (!preview.ok) throw new Error("expected a preview");
    const original = preview.preview.sha256;
    const external = `${JSON.stringify(
      { penguinManaged: "true", configVersion: 1, endpoint: "https://racer.example" },
      null,
      2,
    )}\n`;
    // The apply reads the file twice: once for the gate, once immediately before the rename. The
    // only way to make those two reads disagree is for the file to change in between, so the
    // getter writes it synchronously on the first read of the expected hash — after the preview
    // and before the second read. That is exactly the race the second check exists for.
    let reads = 0;
    const options = {
      patch: { endpoint: "https://ours.example" },
      get expectedSha256(): string {
        reads += 1;
        if (reads === 1) writeFileSync(configPath, external);
        return original;
      },
    };
    const result = await applyForeignConfig(
      configPath,
      adapter,
      options as unknown as { patch: Record<string, string>; expectedSha256: string },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("changed-since-preview");
    expect(result.diagnostics.join(" ")).toContain("second check");
    expect(await readFile(configPath, "utf8")).toBe(external);
    expect(await backupsIn()).toEqual([]);
  });

  it("reports a failed rename, restores the original byte-for-byte, and keeps the backup", async () => {
    const before = await write(MANAGED);
    const preview = await previewForeignConfig(configPath, adapter);
    if (!preview.ok) throw new Error("expected a preview");
    // ENOSPC (a full disk) is a write failure that is *not* about permissions: the backup is
    // taken, the replacement cannot be published, and the original is restored from the backup.
    fault.renameCode = "ENOSPC";
    const result = await applyForeignConfig(configPath, adapter, {
      patch: { endpoint: "https://new.example" },
      expectedSha256: preview.preview.sha256,
    });
    fault.renameCode = "";

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("write-failed");
    expect(result.failedAt).toBe("write");
    expect(result.stages).toContain("restore");
    expect(result.originalPreserved).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(result.backupPath).not.toBeNull();
    expect(await readFile(result.backupPath!, "utf8")).toBe(before);
    // No temporary file was left behind by the failed publication.
    const leftovers = (await readdir(path.dirname(configPath))).filter((name) =>
      name.includes(".tmp-"),
    );
    expect(leftovers).toEqual([]);
  });

  it("maps a rename refused by the operating system to permission-denied, original restored", async () => {
    const before = await write(MANAGED);
    const preview = await previewForeignConfig(configPath, adapter);
    if (!preview.ok) throw new Error("expected a preview");
    // EPERM/EACCES out of the rename is what a read-only or immutable file produces: the write is
    // refused rather than corrupt, and the original goes back from the backup in the same call.
    fault.renameCode = "EPERM";
    const result = await applyForeignConfig(configPath, adapter, {
      patch: { endpoint: "https://new.example" },
      expectedSha256: preview.preview.sha256,
    });
    fault.renameCode = "";
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("permission-denied");
    expect(result.originalPreserved).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it.skipIf(process.platform === "win32")(
    "reports a permission denial with the original intact",
    async () => {
      const before = await write(MANAGED);
      const preview = await previewForeignConfig(configPath, adapter);
      if (!preview.ok) throw new Error("expected a preview");
      // A directory that cannot be written cannot receive the temporary file, so the failure lands
      // before anything is replaced.
      await chmod(directory, 0o500);
      const result = await applyForeignConfig(configPath, adapter, {
        patch: { endpoint: "https://new.example" },
        expectedSha256: preview.preview.sha256,
      });
      await chmod(directory, 0o700);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(["permission-denied", "write-failed"]).toContain(result.code);
      expect(result.originalPreserved).toBe(true);
      expect(await readFile(configPath, "utf8")).toBe(before);
    },
  );
});

describe("H1.3 — adoption and symlink policy", () => {
  it("adopts an unmanaged file through a transaction that backs up the original", async () => {
    const before = await write(UNMANAGED);
    const result = await adoptForeignConfig(configPath, adapter, {
      expectedSha256: await shaOf(configPath),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.readback.penguinManaged).toBe("true");
    expect(await readFile(result.backupPath, "utf8")).toBe(before);
    // The unmanaged keys survived adoption.
    const adopted = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(adopted.endpoint).toBe("https://foreign.example");
    expect(adopted.apiKey).toBe("sk-other-9999");

    // And now the same file accepts a normal apply.
    const preview = await previewForeignConfig(configPath, adapter);
    if (!preview.ok) throw new Error("expected a preview");
    expect(preview.preview.isManagedProvider).toBe(true);
    const applied = await applyForeignConfig(configPath, adapter, {
      patch: { endpoint: "https://managed.example" },
      expectedSha256: preview.preview.sha256,
    });
    expect(applied.ok).toBe(true);
  });

  it("refuses to adopt a file that is already managed", async () => {
    await write(MANAGED);
    const result = await adoptForeignConfig(configPath, adapter, {
      expectedSha256: await shaOf(configPath),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unmanaged-provider");
    expect(result.message).toContain("already managed");
  });

  it("follows a symlinked config when asked, and records the chain at preview", async () => {
    const real = path.join(backupDirectory, "real-settings.json");
    await write(MANAGED, real);
    await symlink(real, configPath);
    const preview = await previewForeignConfig(configPath, adapter);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.symlink).toEqual({ hops: 1, resolved: real });
    expect(preview.preview.isManagedProvider).toBe(true);

    const result = await applyForeignConfig(configPath, adapter, {
      patch: { endpoint: "https://through-the-link.example" },
      expectedSha256: preview.preview.sha256,
      followSymlinks: true,
    });
    expect(result.ok).toBe(true);
    // The write landed on the link's target; the link is still a link.
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    const content = JSON.parse(await readFile(real, "utf8")) as Record<string, unknown>;
    expect(content.endpoint).toBe("https://through-the-link.example");
  });

  it("refuses a symlink chain that ends nowhere, and a chain that ends at a directory", async () => {
    await symlink(path.join(directory, "missing.json"), configPath);
    const dangling = await previewForeignConfig(configPath, adapter);
    // A dangling link is not ambiguous: nothing is there, and the caller creates the file. It is
    // the *chain* that must terminate, not the target that must exist.
    expect(dangling.ok).toBe(true);

    const loop = path.join(directory, "loop.json");
    await symlink(loop, loop);
    const cycle = await previewForeignConfig(loop, adapter);
    expect(cycle.ok).toBe(false);
    if (cycle.ok) return;
    expect(cycle.code).toBe("symlink-target-ambiguous");
    expect(cycle.message).toContain("does not terminate");

    const toDirectory = path.join(directory, "config-dir");
    await mkdir(toDirectory, { recursive: true });
    const directoryLink = path.join(directory, "dir-link.json");
    await symlink(toDirectory, directoryLink);
    const ambiguous = await previewForeignConfig(directoryLink, adapter);
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    expect(ambiguous.code).toBe("symlink-target-ambiguous");
    expect(ambiguous.message).toContain("not a regular file");
  });
});

describe("H1.4 — restoration", () => {
  it("restores the backup byte-for-byte with its permissions", async () => {
    const before = await write(MANAGED);
    await chmod(configPath, 0o600);
    const backupPath = backupPathFor(configPath, await shaOf(configPath));
    await copyFile(configPath, backupPath);
    await chmod(backupPath, 0o600);
    const expectedMode = await modeOf(backupPath);
    await write(
      `${JSON.stringify({ penguinManaged: "true", configVersion: 1, endpoint: "https://edited.example" })}\n`,
    );
    await chmod(configPath, 0o644);

    expect(await restoreForeignConfig(backupPath, configPath)).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await modeOf(configPath)).toBe(expectedMode);
  });

  it("reports a failed restore instead of claiming success", async () => {
    expect(await restoreForeignConfig(path.join(directory, "no-such-backup"), configPath)).toBe(
      false,
    );
  });

  it("masks secrets of four characters or fewer without leaking length", () => {
    expect(redactValue("sk-live-1234")).toBe("****1234");
    expect(redactValue("abc")).toBe("****");
    expect(redactValue("")).toBe("****");
  });
});

describe("H1 — the project-config adapter is conservative about what it does not model", () => {
  it("treats an unmarked project config as unmanaged and refuses a rewrite", async () => {
    const toml = 'default_model = { provider = "anthropic", model_id = "claude-sonnet-4-6" }\n';
    const before = await write(toml);
    const preview = await previewForeignConfig(configPath, PROJECT_CONFIG_ADAPTER);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.isManagedProvider).toBe(false);

    const result = await applyForeignConfig(configPath, PROJECT_CONFIG_ADAPTER, {
      patch: { default_model: "x" },
      expectedSha256: preview.preview.sha256,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unmanaged-provider");
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("round-trips a managed TOML config, keeping tables and unknown keys", async () => {
    const toml = [
      "penguin_managed = true",
      "penguin_version = 1",
      'name = "demo"',
      "",
      "[command_policy]",
      'deny = ["rm -rf /"]',
      "",
      "[[models]]",
      'provider = "anthropic"',
      'model_id = "claude-sonnet-4-6"',
      "",
    ].join("\n");
    await write(toml);
    const preview = await previewForeignConfig(configPath, PROJECT_CONFIG_ADAPTER);
    if (!preview.ok) throw new Error("expected a preview");
    expect(preview.preview.isManagedProvider).toBe(true);
    expect(preview.preview.version).toBe(1);

    const result = await applyForeignConfig(configPath, PROJECT_CONFIG_ADAPTER, {
      patch: { name: "renamed" },
      expectedSha256: preview.preview.sha256,
    });
    expect(result.ok).toBe(true);
    const after = await readFile(configPath, "utf8");
    // The new key replaced its line; the table, the array and the array-of-tables are untouched.
    expect(after).toContain('name = "renamed"');
    expect(after).toContain("[command_policy]");
    expect(after).toContain('deny = ["rm -rf /"]');
    expect(after).toContain("[[models]]");
    expect(after.indexOf("[[models]]")).toBeGreaterThan(after.indexOf("[command_policy]"));
    expect(PROJECT_CONFIG_ADAPTER.inspect(after).version).toBe(1);
  });
});
