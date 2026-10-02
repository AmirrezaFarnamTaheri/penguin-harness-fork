/**
 * H5: simple / default / full help, driven through `cli()`.
 *
 * The card's acceptance is about what a reader can reach, so these cases assert the inventory each
 * mode shows (by name, from the live registry), the exit semantics of every entry point, and the
 * two failure-shaped situations a help page has to survive: a narrow terminal and a long localized
 * description. The pure functions (`parseHelpMode`, `helpModeFromArgv`, `fitDescription`,
 * `commandInMode`, `helpWidth`, `renderCommandHelp`) are covered directly as well, because a
 * snapshot of `cli()` output can pass while the mode logic itself regressed.
 */
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli } from "../src/index.js";
import { getMessages } from "../src/i18n.js";
import {
  applyHelpMode,
  commandInMode,
  COMMAND_TIERS,
  fitDescription,
  helpModeFromArgv,
  HELP_MODE_FLAG,
  helpWidth,
  isMalformedHelpMode,
  parseHelpMode,
  unclassifiedCommands,
} from "../src/help-modes.js";

let stdout: string[];
let stderr: string[];
let outSpy: { mockRestore(): void };
let errSpy: { mockRestore(): void };
let priorLang: string | undefined;
let priorColumns: number | undefined;

beforeEach(() => {
  stdout = [];
  stderr = [];
  priorLang = process.env.PENGUIN_LANG;
  priorColumns = process.stdout.columns;
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  if (priorLang === undefined) delete process.env.PENGUIN_LANG;
  else process.env.PENGUIN_LANG = priorLang;
  if (priorColumns === undefined) delete (process.stdout as { columns?: number }).columns;
  else process.stdout.columns = priorColumns;
});

const out = () => stdout.join("");
const err = () => stderr.join("");

describe("H5.1 mode parsing", () => {
  it("reads both spellings of the flag, last one winning", () => {
    expect(helpModeFromArgv([]).mode).toBe("default");
    expect(helpModeFromArgv(["--help-mode", "simple"]).mode).toBe("simple");
    expect(helpModeFromArgv(["--help-mode=full"]).mode).toBe("full");
    expect(helpModeFromArgv(["--help-mode", "simple", "--help-mode=full"]).mode).toBe("full");
    // A flag with no value is malformed, not "default": the user asked for something.
    expect(helpModeFromArgv(["--help-mode"]).raw).toBe("");
    expect(isMalformedHelpMode("")).toBe(true);
    expect(parseHelpMode(undefined)).toBe("default");
    expect(parseHelpMode("nope")).toBeNull();
    expect(HELP_MODE_FLAG).toBe("--help-mode");
  });

  it("clamps terminal widths, defaulting to 80", () => {
    expect(helpWidth(undefined)).toBe(80);
    expect(helpWidth(0)).toBe(80);
    expect(helpWidth(Number.NaN)).toBe(80);
    expect(helpWidth(20)).toBe(56);
    expect(helpWidth(500)).toBe(100);
    expect(helpWidth(72.4)).toBe(72);
  });
});

describe("H5.2 the live registry is the inventory", () => {
  it("classifies every registered command, and fails open for anything unclassified", async () => {
    // A command registered without a tier still appears (help must never hide a command)…
    expect(commandInMode("brand-new-command", "default")).toBe(true);
    expect(commandInMode("brand-new-command", "simple")).toBe(true);
    // …and the tier table decides for the ones it knows.
    expect(commandInMode("run", "simple")).toBe(true);
    expect(commandInMode("schedule", "simple")).toBe(false);
    expect(commandInMode("schedule", "default")).toBe(true);
    expect(COMMAND_TIERS["recall"]).toBe("simple");

    // The gap itself is visible: this is the assertion that fails when a command is added without
    // a tier, instead of silently bloating `simple`.
    const program = new Command();
    program
      .command("beta")
      .description("x")
      .action(() => undefined);
    for (const name of ["alpha", "gamma"].filter((n) => !(n in COMMAND_TIERS))) {
      program
        .command(name)
        .description("x")
        .action(() => undefined);
    }
    // `unclassifiedCommands` reports what is missing from the table — here, our two fixtures.
    expect(unclassifiedCommands(program)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("shows the simple tier in full and the full tier only in full", async () => {
    process.env.PENGUIN_LANG = "en";
    await cli(["--help-mode", "simple", "--help"]);
    const simple = out();
    expect(simple).toContain("run");
    expect(simple).toContain("recall");
    expect(simple).toContain("server");
    expect(simple).not.toContain("schedule");
    expect(simple).not.toContain("org");

    stdout = [];
    await cli(["--help"]);
    const dflt = out();
    expect(dflt).toContain("schedule");
    expect(dflt).toContain("cost");
    // Aliases are a `full`-only detail: the default stays readable.
    expect(dflt).not.toMatch(/^\s+\S+ \(/m);

    stdout = [];
    await cli(["--help-mode", "full", "--help"]);
    const full = out();
    for (const name of Object.keys(COMMAND_TIERS)) expect(full, name).toContain(name);
    expect(full).toContain("--help-mode");
    expect(full).toContain("-h, --help");
  });

  it("truncates a long description by whole words and keeps it whole in full", () => {
    const long = "one two three four five six seven eight nine ten";
    const cut = fitDescription(long, "default", 20);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(20);
    expect(cut).not.toContain("  ");
    expect(long.startsWith(cut.slice(0, -1).trimEnd())).toBe(true);
    expect(fitDescription(long, "full", 20)).toBe(long);
    expect(fitDescription("short", "simple", 20)).toBe("short");
    expect(fitDescription("", "simple", 20)).toBe("");
  });
});

describe("H5.3 errors and guidance keep their mode", () => {
  it("reports a malformed mode as a localized usage error without echoing the value", async () => {
    for (const lang of ["en", "zh"] as const) {
      process.env.PENGUIN_LANG = lang;
      stderr = [];
      stdout = [];
      const t = getMessages(lang);
      const code = await cli(["--help-mode", "sideways", "--help"]);
      expect(code).toBe(1);
      expect(err()).toContain(t.help.invalidMode());
      expect(err()).toContain("penguin");
      expect(err()).not.toContain("sideways");
      expect(out()).toBe("");
    }
  });

  it("keeps unknown-command guidance working in every mode", async () => {
    process.env.PENGUIN_LANG = "en";
    for (const mode of ["simple", "default", "full"] as const) {
      stderr = [];
      const code = await cli(["--help-mode", mode, "logss"]);
      expect(code).toBe(1);
      expect(err()).toContain("unknown command");
      // The suggestion still comes from the registered vocabulary.
      expect(err()).toContain("logs");
      expect(err()).toContain("penguin");
    }
  });
});

describe("H5.4 snapshots: modes, nesting, locales, widths, exit semantics", () => {
  it("renders every mode in both locales with stable labels", async () => {
    for (const lang of ["en", "zh"] as const) {
      const t = getMessages(lang);
      process.env.PENGUIN_LANG = lang;
      for (const mode of ["simple", "default", "full"] as const) {
        stdout = [];
        expect(await cli(["--help-mode", mode, "--help"])).toBe(0);
        expect(out()).toContain(t.help.usageLabel);
        expect(out()).toContain(t.help.commandsLabel);
        expect(out()).toContain(t.help.optionsLabel);
        if (mode !== "full") expect(out()).toContain(t.help.moreCommands);
      }
    }
  });

  it("keeps a narrow terminal readable and never exceeds the clamped width", async () => {
    process.env.PENGUIN_LANG = "en";
    process.stdout.columns = 50;
    stdout = [];
    expect(await cli(["--help"])).toBe(0);
    const lines = out()
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(56);
  });

  it("shows a nested command its own subcommands and points at full", async () => {
    process.env.PENGUIN_LANG = "en";
    stdout = [];
    expect(await cli(["schedule", "--help"])).toBe(0);
    expect(out()).toContain("penguin schedule [options] [command]");
    expect(out()).toContain("add");
    expect(out()).toContain("rm");
    // Nothing is hidden from this page (tiering is root-level, and its own options are listed),
    // so no pointer and no "global options" section are invented for it; the fixture below proves
    // both appear when there really is an inherited option to point at.
    expect(out()).not.toContain(getMessages("en").help.globalOptionsLabel);
    expect(out()).not.toContain(getMessages("en").help.moreCommands);
  });

  it("lists a subcommand's inherited options in full, and only in full", () => {
    const t = getMessages("en");
    const program = new Command();
    program.name("penguin").description("d").option("--root <dir>", "data root");
    const outer = program.command("outer").description("outer");
    outer.command("inner").description("inner").option("--json", "json out");
    applyHelpMode(program, "full", 80, t);
    const innerHelp = (mode: "full" | "default") => {
      applyHelpMode(program, mode, 80, t);
      const inner = outer.commands[0]!;
      const helper = inner.createHelp();
      return helper.formatHelp(inner, helper);
    };
    const full = innerHelp("full");
    expect(full).toContain(t.help.globalOptionsLabel);
    expect(full).toContain("--root");
    expect(full).toContain("--json");
    const dflt = innerHelp("default");
    expect(dflt).not.toContain(t.help.globalOptionsLabel);
    // The concise mode still tells the reader where the rest is.
    expect(dflt).toContain(t.help.moreCommands);
    // Navigational flags are never presented as "global options".
    expect(full).not.toMatch(/Global options:[\s\S]*--version/);
  });

  it("keeps bare invocation, --version and --help exiting 0", async () => {
    for (const argv of [[], ["--help"], ["-h"], ["--version"], ["-v"]]) {
      stdout = [];
      expect(await cli(argv), argv.join(" ")).toBe(0);
      expect(out().length, argv.join(" ")).toBeGreaterThan(0);
    }
    // `--help` with a mode and a command still exits 0 and shows that command's page.
    stdout = [];
    expect(await cli(["--help-mode", "simple", "run", "--help"])).toBe(0);
    expect(out()).toContain("penguin run");
  });

  it("applies the mode to nested commands too, not just the root", () => {
    const t = getMessages("en");
    const program = new Command();
    program.name("penguin").description("d");
    const child = program.command("outer").description("outer command");
    child.command("inner").description("inner command");
    applyHelpMode(program, "simple", 80, t);
    // The nested page still lists its own children (tiering is a root-level policy)…
    const outerHelp = program.commands[0]!.createHelp();
    expect(outerHelp.formatHelp(program.commands[0]!, outerHelp)).toContain("inner");
    // …and the root respects the mode.
    const rootHelp = program.createHelp();
    expect(rootHelp.formatHelp(program, rootHelp)).toContain("outer");
  });
});
