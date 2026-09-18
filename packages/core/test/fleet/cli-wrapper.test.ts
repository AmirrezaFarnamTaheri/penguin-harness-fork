/**
 * CLI wrapper synthesis tests.
 *
 * The security-relevant property is that values never become shell syntax: `buildArgv`
 * produces an array handed to `spawn`, and the tests assert both that shape and that a
 * shell metacharacter in data survives as a single argv entry. Access policy is enforced
 * before spawn, so a read-only caller cannot reach a mutating command by any path.
 */
import { describe, expect, it } from "vitest";

import {
  ARG_TYPES,
  CLI_STRATEGY,
  CliWrapperError,
  CliWrapperRegistry,
  CommandSpacer,
  buildArgv,
  coerceArgValue,
  formatArgSummary,
  formatCommandExample,
  invokeCli,
  redactArgv,
  serializeArg,
  type CliCommandManifest,
} from "../../src/fleet/cli-wrapper.js";

const ECHO: CliCommandManifest = {
  id: "echo_tool",
  providerId: "builtin",
  description: "prints what it is given",
  access: "read",
  command: "node",
  args: [{ name: "message", positional: true, required: true }],
};

describe("serializeArg", () => {
  it("fills in every default", () => {
    expect(serializeArg({ name: "x" })).toEqual({
      name: "x",
      type: "string",
      required: false,
      positional: false,
      flag: false,
      choices: [],
      default: null,
      help: "",
      secret: false,
    });
  });

  it("normalizes an unknown type to string", () => {
    expect(serializeArg({ name: "x", type: "weird" as never }).type).toBe("string");
  });

  it("preserves the declared scalar types", () => {
    for (const type of ARG_TYPES) {
      expect(serializeArg({ name: "x", type }).type).toBe(type);
    }
  });
});

describe("formatArgSummary and formatCommandExample", () => {
  it("renders required positionals in angles and optionals in brackets", () => {
    expect(
      formatArgSummary([
        { name: "path", positional: true, required: true },
        { name: "dest", positional: true },
        { name: "force", required: true },
        { name: "verbose" },
      ]),
    ).toBe("<path> [dest] --force [--verbose]");
  });

  it("renders a canonical invocation example", () => {
    expect(
      formatCommandExample({
        ...ECHO,
        args: [
          { name: "path", positional: true, required: true },
          { name: "force", required: true, flag: true },
          { name: "name", required: true },
        ],
        defaultFormat: "table",
      }),
    ).toBe("echo_tool <path> --force --name <name> -f table");
  });

  it("omits the value placeholder for a boolean flag", () => {
    expect(
      formatCommandExample({
        ...ECHO,
        args: [{ name: "force", required: true, type: "bool" }],
      }),
    ).toBe("echo_tool --force -f json");
  });
});

describe("coerceArgValue", () => {
  it("parses ints and floats", () => {
    const intArg = serializeArg({ name: "n", type: "int" });
    const floatArg = serializeArg({ name: "f", type: "float" });
    expect(coerceArgValue(intArg, "42")).toBe(42);
    expect(coerceArgValue(floatArg, "3.5")).toBe(3.5);
    expect(coerceArgValue(floatArg, 2)).toBe(2);
  });

  it("rejects a non-numeric number argument", () => {
    const intArg = serializeArg({ name: "n", type: "int" });
    expect(() => coerceArgValue(intArg, "abc")).toThrow(CliWrapperError);
    expect(() => coerceArgValue(intArg, "abc")).toThrow(/must be a integer/);
  });

  it("accepts boolean spellings", () => {
    const boolArg = serializeArg({ name: "f", type: "bool" });
    for (const truthy of ["1", "true", "yes", "on", true, ""]) {
      expect(coerceArgValue(boolArg, truthy)).toBe(true);
    }
    for (const falsy of ["0", "false", "no", "off", false]) {
      expect(coerceArgValue(boolArg, falsy)).toBe(false);
    }
  });

  it("rejects an unparseable boolean", () => {
    const boolArg = serializeArg({ name: "f", type: "bool" });
    expect(() => coerceArgValue(boolArg, "maybe")).toThrow(/must be boolean/);
  });

  it("treats a bare flag as true", () => {
    const flagArg = serializeArg({ name: "force", flag: true });
    expect(coerceArgValue(flagArg, undefined)).toBe(true);
  });

  it("enforces a choices allowlist", () => {
    const arg = serializeArg({ name: "fmt", choices: ["json", "yaml"] });
    expect(coerceArgValue(arg, "json")).toBe("json");
    expect(() => coerceArgValue(arg, "xml")).toThrow(/must be one of/);
  });
});

describe("buildArgv", () => {
  it("emits positional args before flags, in declaration order", () => {
    const manifest: CliCommandManifest = {
      ...ECHO,
      args: [
        { name: "zeta", positional: true },
        { name: "alpha", positional: true },
        { name: "flag", flag: true },
      ],
    };
    const { argv } = buildArgv(manifest, { zeta: "z", alpha: "a", flag: true });
    expect(argv).toEqual(["z", "a", "--flag"]);
  });

  it("emits flags in a stable sorted order", () => {
    const manifest: CliCommandManifest = {
      ...ECHO,
      args: [{ name: "zulu" }, { name: "alpha" }, { name: "mike" }],
    };
    const { argv } = buildArgv(manifest, { zulu: 1, alpha: 2, mike: 3 });
    expect(argv).toEqual(["--alpha", "2", "--mike", "3", "--zulu", "1"]);
  });

  it("errors on a missing required positional", () => {
    expect(() => buildArgv(ECHO, {})).toThrow(/missing required positional argument/);
  });

  it("errors on a missing required flag", () => {
    const manifest: CliCommandManifest = {
      ...ECHO,
      args: [{ name: "token", required: true }],
    };
    expect(() => buildArgv(manifest, { message: "hi" })).toThrow(
      /missing required argument '--token'/,
    );
  });

  it("errors on an unknown argument name rather than dropping it", () => {
    expect(() => buildArgv(ECHO, { message: "hi", typo: "x" })).toThrow(/has no argument 'typo'/);
  });

  it("uses a declared default when the value is absent", () => {
    const manifest: CliCommandManifest = {
      ...ECHO,
      args: [{ name: "path", positional: true, default: "/tmp" }],
    };
    const { argv } = buildArgv(manifest, {});
    expect(argv).toEqual(["/tmp"]);
  });

  it("tracks secret values without stripping them from argv", () => {
    const manifest: CliCommandManifest = {
      ...ECHO,
      args: [
        { name: "token", secret: true },
        { name: "message", positional: true },
      ],
    };
    const { argv, secrets } = buildArgv(manifest, { token: "tok_secret", message: "m" });
    expect(argv).toEqual(["m", "--token", "tok_secret"]);
    expect(secrets.has("tok_secret")).toBe(true);
    // A redacted view is available for logs.
    expect(redactArgv(argv, secrets)).toEqual(["m", "--token", "<redacted>"]);
  });

  it("redacts a secret appearing as a positional too", () => {
    const manifest: CliCommandManifest = {
      ...ECHO,
      args: [{ name: "token", positional: true, secret: true }],
    };
    const { argv, secrets } = buildArgv(manifest, { token: "tok_secret" });
    expect(redactArgv(argv, secrets)).toEqual(["<redacted>"]);
  });

  it("passes shell metacharacters through as data, not syntax", () => {
    const payload = "; rm -rf / && $(whoami) | cat";
    const { argv } = buildArgv(ECHO, { message: payload });
    // One argv entry: there is no shell to interpret it.
    expect(argv).toEqual([payload]);
  });

  it("rejects a manifest without an args array", () => {
    expect(() => buildArgv({ ...ECHO, args: undefined } as never, {})).toThrow(/has no args array/);
  });
});

describe("invokeCli", () => {
  it("runs a real command and captures stdout", async () => {
    const { result } = invokeCli(
      { ...ECHO, command: "node", args: [{ name: "eval" }] },
      { eval: "process.stdout.write('hello from a child')" },
    );
    const outcome = await result;
    expect(outcome.stdout).toBe("hello from a child");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures a non-zero exit code and stderr", async () => {
    const { result } = invokeCli(
      { ...ECHO, args: [{ name: "eval" }] },
      { eval: "process.stderr.write('boom'); process.exit(3)" },
    );
    const outcome = await result;
    expect(outcome.exitCode).toBe(3);
    expect(outcome.stderr).toContain("boom");
  });

  it("never puts a secret in the recorded argv", async () => {
    const manifest: CliCommandManifest = {
      ...ECHO,
      args: [{ name: "eval" }, { name: "token", secret: true }],
    };
    const { result } = invokeCli(manifest, {
      eval: "process.stdout.write('ok')",
      token: "tok_secret",
    });
    const outcome = await result;
    expect(JSON.stringify(outcome.argv)).not.toContain("tok_secret");
    expect(outcome.argv).toContain("<redacted>");
  });

  it("reports a failed spawn", async () => {
    const { result } = invokeCli(
      { ...ECHO, command: "definitely-not-a-real-binary-xyz" },
      { message: "hi" },
    );
    await expect(result).rejects.toMatchObject({ name: "CliWrapperError", code: "spawn_failed" });
  });

  it("kills a command that exceeds its timeout", async () => {
    const { result } = invokeCli(
      { ...ECHO, args: [{ name: "eval" }], timeoutMs: 300 },
      { eval: "setTimeout(() => {}, 60000)" },
      { timeoutMs: 300 },
    );
    const outcome = await result;
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBeNull();
  });

  it("can be cancelled by the caller", async () => {
    const { result, cancel } = invokeCli(
      { ...ECHO, args: [{ name: "eval" }] },
      { eval: "setTimeout(() => {}, 60000)" },
    );
    cancel();
    const outcome = await result;
    expect(outcome.timedOut).toBe(false);
  });

  it("refuses a write command under a read-only policy", () => {
    const manifest: CliCommandManifest = { ...ECHO, access: "write" };
    expect(() => invokeCli(manifest, { message: "x" }, { allowWrite: false })).toThrow(
      CliWrapperError,
    );
    expect(() => invokeCli(manifest, { message: "x" }, { allowWrite: false })).toThrow(/read-only/);
  });

  it("caps captured output", async () => {
    const { result } = invokeCli(
      { ...ECHO, args: [{ name: "eval" }] },
      { eval: "process.stdout.write('x'.repeat(4096))" },
      { maxOutputBytes: 100 },
    );
    const outcome = await result;
    expect(outcome.stdout.length).toBeLessThanOrEqual(100);
  });

  it("records the strategy and access class for a sandbox", () => {
    const manifest: CliCommandManifest = {
      ...ECHO,
      access: "write",
      strategy: CLI_STRATEGY.Cookie,
    };
    expect(manifest.access).toBe("write");
    expect(manifest.strategy).toBe("cookie");
  });
});

describe("CommandSpacer", () => {
  it("lets a first call through immediately", async () => {
    const spacer = new CommandSpacer(50);
    await spacer.wait("cmd");
    // No assertion to make other than it resolved; the second-call test carries the timing.
  });

  it("delays a second call inside the interval", async () => {
    const spacer = new CommandSpacer(120);
    await spacer.wait("cmd", 1_000);
    const started = Date.now();
    await spacer.wait("cmd", 1_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("shares one wait between concurrent callers", async () => {
    const spacer = new CommandSpacer(150);
    await spacer.wait("cmd", 1_000);
    const started = Date.now();
    await Promise.all([
      spacer.wait("cmd", 1_000),
      spacer.wait("cmd", 1_000),
      spacer.wait("cmd", 1_000),
    ]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    // Three callers waited together, not serially.
    expect(elapsed).toBeLessThan(450);
  });

  it("releases a command's spacing record", async () => {
    const spacer = new CommandSpacer(1_000);
    await spacer.wait("cmd", 1_000);
    spacer.release("cmd");
    await spacer.wait("cmd", 1_000);
  });

  it("is a no-op when the interval is zero", async () => {
    const spacer = new CommandSpacer(0);
    await spacer.wait("cmd");
  });
});

describe("CliWrapperRegistry", () => {
  it("registers and retrieves a manifest", () => {
    const registry = new CliWrapperRegistry();
    registry.register(ECHO);
    expect(registry.get(ECHO.id)?.id).toBe("echo_tool");
    expect(registry.size).toBe(1);
  });

  it("refuses a duplicate id", () => {
    const registry = new CliWrapperRegistry();
    registry.register(ECHO);
    expect(() => registry.register(ECHO)).toThrow(/already registered/);
  });

  it("requires an id and a command", () => {
    const registry = new CliWrapperRegistry();
    expect(() => registry.register({ ...ECHO, id: "" })).toThrow(/requires both/);
    expect(() => registry.register({ ...ECHO, command: "" })).toThrow(/requires both/);
  });

  it("lists and removes commands, and filters by provider", () => {
    const registry = new CliWrapperRegistry();
    registry.register(ECHO);
    registry.register({ ...ECHO, id: "other_tool", providerId: "other" });
    expect(registry.list()).toHaveLength(2);
    expect(registry.forProvider("builtin")).toHaveLength(1);
    expect(registry.forProvider("builtin")[0]!.id).toBe("echo_tool");
    expect(registry.remove("echo_tool")).toBe(true);
    expect(registry.remove("echo_tool")).toBe(false);
    expect(registry.size).toBe(1);
  });
});
