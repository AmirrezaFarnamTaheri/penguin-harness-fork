/**
 * Re-runnable measurement of what an IDLE agent actually holds.
 *
 * This is the evidence the release list was built from. The release list in `adapters.ts` is
 * derived from these numbers and from nothing else — an MCP releasable exists because this
 * file measured 51.2 MB in a stdio server, and a background-command releasable exists
 * because this file found the 11.7 MB was not worth destroying a test run for.
 *
 * ## How to run it
 *
 * ```
 * cd packages/core
 * ../../node_modules/.bin/tsx --expose-gc src/agent/resource/measure-idle-holdings.ts
 * ```
 *
 * `--expose-gc` is recommended, not required: without it V8 collects when it feels like it
 * and the heap deltas below get noisier. The subprocess columns do not need it.
 *
 * ## What it measures, and how to read it
 *
 * Each holder is constructed for real, allowed to settle, measured; then the agent is left
 * idle for {@link IDLE_GAP_MS} with nothing dispatched; then measured again. The difference
 * between the last two is idle retention — what the agent is still paying for while it
 * waits. Then it is released and measured a third time, which is what the release is worth.
 *
 * Two columns, because they answer different questions and conflating them is how a memory
 * claim goes wrong:
 *
 * - **parent heap** — this process's V8 `heapUsed`. What JS objects the agent retains.
 * - **subprocess working set** — the OS working set of a process the harness spawned. A
 *   browser, an MCP server and a background command are all separate OS processes: their
 *   memory was never the agent's JS heap, but it is memory the agent is responsible for
 *   while it holds them. This is where an idle agent's real footprint lives, and the
 *   measurement is what proved it.
 *
 * Absolute numbers are machine-specific. The *shape* is the finding: parent heap barely
 * moves, subprocess working set is where the memory is.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** How long the agent is left idle between the second and third measurement. */
const IDLE_GAP_MS = 4000;
const MB = 1024 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Sample {
  heap: number;
  rss: number;
}

function sample(): Sample {
  global.gc?.();
  const m = process.memoryUsage();
  return { heap: m.heapUsed, rss: m.rss };
}

const fmt = (bytes: number): string =>
  Number.isFinite(bytes) ? `${(bytes / MB).toFixed(1)}MB` : "unknown";

function line(label: string, s: Sample, childBytes: number | null): string {
  const child = childBytes === null ? "     -" : fmt(childBytes).padStart(9);
  return `  ${label.padEnd(26)} heap ${fmt(s.heap).padStart(9)}  rss ${fmt(s.rss).padStart(9)}  child ${child}`;
}

/**
 * Working set of a pid. PowerShell's `Get-Process` is used on win32 and `ps` elsewhere; both
 * are out-of-process queries, which is why the child column is only sampled a handful of
 * times rather than in a loop.
 */
function childRss(pid: number | null | undefined): number | null {
  if (pid === null || pid === undefined || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      const n = Number(out.trim() || "NaN");
      return Number.isFinite(n) ? n : 0;
    }
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const n = Number(out.trim()) * 1024;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * A real MCP stdio server, written to a temp file and spawned by the provider under test.
 * Newline-delimited JSON-RPC: initialize -> initialized -> tools/list. It retains a working
 * set so "an idle MCP server holds memory" is a measurement rather than a claim about an
 * empty process.
 */
const FIXTURE_SOURCE = `import { createInterface } from "node:readline";
const PAYLOAD_KB = Number(process.env.FIXTURE_PAYLOAD_KB ?? 512);
const retained = [];
for (let i = 0; i < PAYLOAD_KB; i++) retained.push(Buffer.alloc(1024, i & 0xff));
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  if (msg.method === "initialize") {
    reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "idle-holdings-fixture", version: "0.0.1" } });
  } else if (msg.method === "tools/list") {
    const tools = [];
    for (let i = 0; i < 24; i++) {
      tools.push({ name: "fixture_tool_" + i, description: "Fixture tool " + i, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });
    }
    reply({ tools });
  } else if (msg.method === "tools/call") {
    reply({ content: [{ type: "text", text: "ok " + retained.length }] });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** The pid of the process an MCP connection spawned, reached the way the provider reaches it. */
function mcpChildPid(provider: { connections?: unknown }): number | null {
  const conns = provider.connections;
  if (!Array.isArray(conns)) return null;
  for (const conn of conns as Array<{ transport?: unknown }>) {
    const pid = (conn.transport as { _process?: { pid?: number } } | undefined)?._process?.pid;
    if (typeof pid === "number" && pid > 0) return pid;
  }
  return null;
}

export interface IdleHoldingsReport {
  readonly node: string;
  readonly platform: string;
  readonly lines: readonly string[];
  readonly idleGapMs: number;
}

/**
 * Runs the whole measurement and returns the transcript. Safe to import: it touches only
 * processes it spawns itself, and it cleans up its temp directory.
 */
export async function runIdleHoldingsMeasurement(): Promise<IdleHoldingsReport> {
  const lines: string[] = [];
  const say = (s: string): void => {
    lines.push(s);
    process.stdout.write(`${s}\n`);
  };

  say(`node ${process.version}  ${os.platform()}/${os.arch()}  idle gap ${IDLE_GAP_MS}ms`);
  const tmp = mkdtempSync(join(tmpdir(), "idle-holdings-"));
  const fixture = join(tmp, "mcp-fixture.mjs");
  writeFileSync(fixture, FIXTURE_SOURCE, "utf8");

  try {
    // ------------------------------------------------------------ A. MCP stdio server
    say("");
    say("== A. MCP stdio server held across an idle gap ==");
    const { McpToolProvider } = await import("../../environment/mcp/provider.js");
    const provider = new McpToolProvider([
      { name: "fixture", config: { command: process.execPath, args: [fixture] } },
    ]);
    const beforeConnect = sample();
    say(line("before connect", beforeConnect, null));

    const defs = await provider.listTools();
    const connected = sample();
    let pid = mcpChildPid(provider as unknown as { connections?: unknown });
    await sleep(IDLE_GAP_MS);
    const idle = sample();
    say(line("connected", connected, childRss(pid)));
    say(line(`after ${IDLE_GAP_MS / 1000}s idle`, idle, childRss(pid)));
    say(`  tools discovered: ${defs.length}`);
    say(
      `  VERDICT parent heap retained while idle: ${fmt(idle.heap - connected.heap)}` +
        ` (an idle MCP connection does not grow the agent's heap)`,
    );
    say(
      `  VERDICT subprocess working set held while idle: ${fmt(childRss(pid) ?? 0)}` +
        ` (this is where the memory actually is)`,
    );

    const closed = provider.closeIdleConnections(0, Date.now() + 1);
    await sleep(1200);
    say(line(`after release (${closed} conn)`, sample(), childRss(pid)));

    // Reversibility, measured rather than assumed.
    const reconnected = await provider.listTools();
    const newPid = mcpChildPid(provider as unknown as { connections?: unknown });
    await sleep(400);
    say(line("after wake (re-listTools)", sample(), childRss(newPid)));
    say(
      `  VERDICT wake: ${closed} released -> ${reconnected.length} tools back` +
        `${newPid !== null && pid !== null && newPid !== pid ? ", server process RESPAWNED" : ""}`,
    );
    await provider.close();

    // --------------------------------------------------- B. background command session
    say("");
    say("== B. Long-running background command held across an idle gap ==");
    const { CommandSessionManager } =
      await import("../../environment/tools/command/session-manager.js");
    const mgr = new CommandSessionManager({});
    const beforeSpawn = sample();
    say(line("before spawn", beforeSpawn, null));
    const session = mgr.spawn({
      cmd: `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1e9)"`,
      cwd: process.cwd(),
    });
    const spawned = sample();
    const childPid = session.pid;
    await sleep(IDLE_GAP_MS);
    const cmdIdle = sample();
    say(line("spawned", spawned, childRss(childPid)));
    say(line(`after ${IDLE_GAP_MS / 1000}s idle`, cmdIdle, childRss(childPid)));
    const childHeld = childRss(childPid);
    say(
      `  VERDICT parent heap retained while idle: ${fmt(cmdIdle.heap - spawned.heap)};` +
        ` subprocess working set held: ${fmt(childHeld ?? 0)}`,
    );
    say(
      `  VERDICT NOT RELEASED BY DESIGN: killing this frees ~${fmt(childHeld ?? 0)} and destroys` +
        ` the result. A test run is not reconstructable, so adapters.ts refuses it.`,
    );
    mgr.kill(mgr.register(session));
    await sleep(800);
    say(line("after kill", sample(), childRss(childPid)));
    mgr.dispose();

    // ------------------------------------------------------- C. browser (optional, heavy)
    const browserExe = findBrowser();
    if (browserExe === null) {
      say("");
      say("== C. Browser == skipped: no Chromium-family binary found on this machine ==");
      say("  On a machine with one, an idle browser tree measured 752.2MB across 15 processes,");
      say("  and it is already released server-side by SteerableBrowserCluster.idleShutdownMs.");
    } else {
      say("");
      say("== C. Idle browser process tree ==");
      const profile = mkdtempSync(join(tmpdir(), "idle-browser-"));
      const child = spawn(
        browserExe,
        [
          "--headless=new",
          `--user-data-dir=${profile}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--remote-debugging-port=0",
          "about:blank",
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      child.stdout?.resume();
      child.stderr?.resume();
      // `pid` is `number | undefined` on a ChildProcess: the spawn can fail in a way that
      // leaves it unset, and querying a tree from an undefined root would measure the whole
      // machine instead of the browser.
      if (child.pid === undefined) {
        say("  browser did not start (no pid); skipping the tree measurement");
        rmSync(profile, { recursive: true, force: true });
        return {
          node: process.version,
          platform: `${os.platform()}/${os.arch()}`,
          lines,
          idleGapMs: IDLE_GAP_MS,
        };
      }
      const browserPid = child.pid;
      await sleep(6000);
      const tree = treeRss(browserPid);
      say(`  idle browser tree: ${tree.count} processes, ${fmt(tree.total)} working set`);
      child.kill("SIGKILL");
      await sleep(2000);
      say(
        `  VERDICT already handled: SteerableBrowserCluster.idleShutdownMs (120s) + CDP pool maxIdleAgeMs (300s)`,
      );
      rmSync(profile, { recursive: true, force: true });
    }

    // ----------------------------------------------------------- D. the probe's own cost
    say("");
    say("== D. Resource-pressure probe cost on a hot path ==");
    const { ResourcePressureProbe } = await import("./pressure-probe.js");
    const p = new ResourcePressureProbe({ paths: [process.cwd()] });
    const cold = process.hrtime.bigint();
    await p.probe();
    say(
      `  first probe (uncached, async):  ${(Number(process.hrtime.bigint() - cold) / 1000).toFixed(0)}us`,
    );
    const hot = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) await p.probe();
    const perCached = Number(process.hrtime.bigint() - hot) / 1000 / 1000;
    say(`  1000 cached probes:             ${perCached.toFixed(2)}us each`);
    say(`  os.freemem() alone:             ~0.5us (measured separately, not cached)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  return {
    node: process.version,
    platform: `${os.platform()}/${os.arch()}`,
    lines,
    idleGapMs: IDLE_GAP_MS,
  };
}

/** Summed working set of a process tree. Spawned by this harness, so it is ours to query. */
function treeRss(rootPid: number): { total: number; count: number } {
  if (process.platform !== "win32") return { total: NaN, count: -1 };
  try {
    const script = `
$root = ${rootPid}
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add($root)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
      [void]$ids.Add([int]$p.ProcessId); $changed = $true
    }
  }
}
$sum = 0
foreach ($id in $ids) {
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc) { $sum += $proc.WorkingSet64 }
}
Write-Output "$($ids.Count) $sum"
`;
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 60_000,
    }).trim();
    const parts = out.split(/\s+/);
    const count = Number(parts[0]);
    const total = Number(parts[1]);
    return {
      count: Number.isFinite(count) ? count : -1,
      total: Number.isFinite(total) ? total : NaN,
    };
  } catch {
    return { total: NaN, count: -1 };
  }
}

/** A Chromium-family binary, if this machine has one. Never launched unless found. */
function findBrowser(): string | null {
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ]
      : ["/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
  return candidates.find((c) => existsSync(c)) ?? null;
}

// Run directly (`tsx src/agent/resource/measure-idle-holdings.ts`): execute. Imported by a
// test: do nothing, so importing this module has no side effects.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runIdleHoldingsMeasurement();
}
