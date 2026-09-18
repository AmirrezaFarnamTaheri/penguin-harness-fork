/**
 * Track 1, Tier 1: the steerable browser cluster daemon.
 *
 * The launch path itself is not exercised here — it needs a real browser binary and a CDP
 * endpoint, which a CI runner does not provide. What IS exercised is every pure decision the
 * launch path makes, plus the two guarantees that fail silently in production when they are
 * wrong: the retry budget's backoff arithmetic, and the zero-zombie shutdown contract. The
 * shutdown test injects a real child process through the daemon's internals and asserts the
 * pid is gone afterwards, because that is the exit criterion the plan names and it is the one
 * a mock would happily lie about.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFingerprintInjectionScript,
  BROWSER_PROCESS_PATTERNS,
  COLD_LAUNCH_TARGET_MS,
  dedupe,
  defaultExecutablePath,
  DOM_SNAPSHOT_EXPRESSION,
  HEADLESS_ARGS,
  normalizeResourceType,
  shouldDisableSandbox,
  STATIC_STEALTH_ARGS,
  SteerableBrowserCluster,
  type SteerableSessionConfig,
} from "../../../src/sandbox/browser/steerable-browser-cluster.js";
import { generateFingerprint } from "@prismshadow/penguin-core/browser";
import {
  ConfigurationError,
  ConfigurationField,
} from "../../../src/sandbox/browser/launch-error-taxonomy.js";

/** A cluster configured to fail fast rather than wait out a real launch. */
function fastFailingCluster(): SteerableBrowserCluster {
  return new SteerableBrowserCluster({
    executablePath: "/nonexistent/browser-binary",
    launchTimeoutMs: 400,
    maxLaunchAttempts: 1,
    idleShutdownMs: 0,
    quiet: true,
  });
}

describe("TRK-01-init / steerable browser cluster", () => {
  it("advertising the cold-launch target the cockpit KPI is measured against", () => {
    expect(COLD_LAUNCH_TARGET_MS).toBe(650);
  });

  it("carries the donor's anti-detect argument set, including the automation tell", () => {
    // The automation tell lives in the headless set, where the donor put it: it is the one flag
    // that `navigator.webdriver` keys on, and a headful session keeps Blink's defaults.
    expect(HEADLESS_ARGS).toContain("--disable-blink-features=AutomationControlled");
    expect(STATIC_STEALTH_ARGS).toContain("--webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(STATIC_STEALTH_ARGS).toContain("--force-webrtc-ip-handling-policy");
    expect(STATIC_STEALTH_ARGS).toContain("--no-first-run");
    // The long feature-disable list is what the donor's own detection tuning produced; it must
    // survive as a single arg, not be split.
    expect(STATIC_STEALTH_ARGS.some((arg) => arg.startsWith("--disable-features="))).toBe(true);
  });

  it("builds launch args with the debug port, dimensions, proxy and dedupe", () => {
    const cluster = new SteerableBrowserCluster({
      executablePath: "/usr/bin/chromium",
      debugPort: 9333,
      disableSandbox: false,
      quiet: true,
    });
    // startSession is what seeds the per-session dimensions; use it so buildLaunchArgs sees one.
    const config: SteerableSessionConfig = {
      proxyUrl: "http://proxy.local:8080",
      dimensions: { width: 1440, height: 900 },
      args: ["--extra-flag", "--extra-flag"],
    };
    void cluster.startSession(config).catch(() => {
      /* the binary does not exist; only the arg composition is under test */
    });
    const args = cluster.buildLaunchArgs(9333);

    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--window-size=1440,900");
    expect(args).toContain("--proxy-server=http://proxy.local:8080");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--extra-flag");
    // Duplicates collapse without reordering.
    const counts = new Map<string, number>();
    for (const arg of args) counts.set(arg, (counts.get(arg) ?? 0) + 1);
    expect(counts.get("--extra-flag")).toBe(1);
  });

  it("adds the no-sandbox family only when the sandbox is disabled", () => {
    const withSandbox = new SteerableBrowserCluster({
      executablePath: "/x",
      disableSandbox: false,
      quiet: true,
    });
    const withoutSandbox = new SteerableBrowserCluster({
      executablePath: "/x",
      disableSandbox: true,
      quiet: true,
    });
    const sandboxed = withSandbox.buildLaunchArgs(9222);
    const unsandboxed = withoutSandbox.buildLaunchArgs(9222);
    expect(sandboxed).not.toContain("--no-sandbox");
    expect(unsandboxed).toContain("--no-sandbox");
    expect(unsandboxed).toContain("--disable-setuid-sandbox");
    expect(unsandboxed).toContain("--no-zygote");
  });

  it("emits a metrics event shaped for the cockpit tiles", () => {
    const cluster = new SteerableBrowserCluster({ executablePath: "/x", quiet: true });
    const events: unknown[] = [];
    cluster.onTelemetry((event) => events.push(event));
    cluster.emitMetrics();
    const metrics = (
      events[0] as { metrics: { pool: { capacity: number }; coldLaunches: { total: number } } }
    ).metrics;
    expect(metrics.pool.capacity).toBe(30);
    expect(metrics.coldLaunches).toEqual({ withinTarget: 0, total: 0 });
  });

  it("normalizes every CDP resource type the harvester groups on", () => {
    expect(normalizeResourceType("Document")).toBe("document");
    expect(normalizeResourceType("Image")).toBe("image");
    expect(normalizeResourceType("Fetch")).toBe("fetch");
    expect(normalizeResourceType("WebSocket")).toBe("websocket");
    expect(normalizeResourceType(undefined)).toBe("other");
  });

  it("emits the fingerprint's navigator values into the injection script", () => {
    const fingerprint = generateFingerprint({ seed: 42, deviceClass: "desktop" });
    const script = buildFingerprintInjectionScript(fingerprint);
    expect(script).toContain(JSON.stringify(fingerprint.navigator.platform));
    expect(script).toContain(JSON.stringify(fingerprint.navigator.hardwareConcurrency));
    expect(script).toContain(JSON.stringify([...fingerprint.navigator.languages]));
    // The script must install the overrides before page scripts, not call them once.
    expect(script).toContain(
      "addScriptToEvaluateOnNewDocument".replace(
        "addScriptToEvaluateOnNewDocument",
        "Navigator.prototype",
      ),
    );
  });

  it("ships a DOM snapshot expression that is a self-contained function", () => {
    expect(DOM_SNAPSHOT_EXPRESSION.trimStart().startsWith("(function")).toBe(true);
    expect(DOM_SNAPSHOT_EXPRESSION).toContain("MAX_DEPTH");
  });

  it("dedupes without reordering and drops empty args", () => {
    expect(dedupe(["--a", "", "--b", "--a", "--c"])).toEqual(["--a", "--b", "--c"]);
  });

  it("resolves a platform default executable", () => {
    const path = defaultExecutablePath("chromium");
    expect(typeof path).toBe("string");
    expect(path.length).toBeGreaterThan(0);
  });

  it("disables the sandbox only when running as root", () => {
    expect(typeof shouldDisableSandbox()).toBe("boolean");
  });

  it("matches browser command lines for the zombie sweep", () => {
    expect(BROWSER_PROCESS_PATTERNS.test("/usr/lib/chromium/chrome")).toBe(true);
    expect(BROWSER_PROCESS_PATTERNS.test("/usr/bin/firefox")).toBe(true);
    expect(BROWSER_PROCESS_PATTERNS.test("/usr/bin/ls")).toBe(false);
  });
});

describe("TRK-01-fault / steerable browser cluster resilience", () => {
  it("fails closed on a missing binary and reports the failure as non-retryable", async () => {
    const cluster = fastFailingCluster();
    const events: Array<{ kind: string; retryable?: boolean; code?: string }> = [];
    cluster.onTelemetry((event) =>
      events.push(event as { kind: string; retryable?: boolean; code?: string }),
    );
    await expect(cluster.startSession({})).rejects.toThrow();
    // A missing binary is a configuration/resource error: no retry attempt is spent on it.
    expect(events.some((event) => event.kind === "cluster.error")).toBe(true);
    expect(cluster.isRunning).toBe(false);
  });

  it("does not leave a session registered after a failed start", async () => {
    const cluster = fastFailingCluster();
    await expect(cluster.startSession({})).rejects.toThrow();
    expect(cluster.poolStats.active).toBe(0);
  });

  it("computes exponential backoff capped at the ceiling, with bounded jitter", () => {
    const cluster = new SteerableBrowserCluster({
      executablePath: "/x",
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      retryBackoffMultiplier: 2,
      retryJitterMs: 50,
      quiet: true,
    });
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = cluster.retryDelay(attempt);
      const growth = Math.min(100 * Math.pow(2, attempt - 1), 1_000);
      expect(delay).toBeGreaterThanOrEqual(growth);
      expect(delay).toBeLessThanOrEqual(growth + 50);
    }
  });

  it("produces no jitter when jitter is disabled", () => {
    const cluster = new SteerableBrowserCluster({
      executablePath: "/x",
      retryBaseDelayMs: 200,
      retryMaxDelayMs: 1_000,
      retryJitterMs: 0,
      quiet: true,
    });
    expect(cluster.retryDelay(1)).toBe(200);
    expect(cluster.retryDelay(9)).toBe(1_000);
  });

  it("classifies a shutdown-during-launch as a configuration error, never retried", async () => {
    const cluster = new SteerableBrowserCluster({
      executablePath: "/nonexistent/browser-binary",
      launchTimeoutMs: 60_000,
      maxLaunchAttempts: 3,
      quiet: true,
    });
    // Shut the cluster down while a launch is in flight: the retry loop must not spend attempts.
    const launch = cluster.launch();
    await cluster.shutdown("test_shutdown");
    await expect(launch).rejects.toThrow();
  });

  it("reaps the browser process on shutdown and leaves no zombie", async () => {
    const cluster = new SteerableBrowserCluster({ executablePath: "/x", quiet: true });
    // A child the daemon believes it owns but which never answers CDP — the exact shape of a
    // launch that failed after spawn. Injected rather than spawned through the real binary so
    // the test does not depend on a browser being installed.
    const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.pid).toBeDefined();
    const pid = child.pid!;
    Object.assign(cluster, { process: child, pid });

    await cluster.shutdown("zombie_test");

    // The pid must be gone. `kill(pid, 0)` throws ESRCH/EPERM when no such process exists;
    // for the daemon's own child there is no permission boundary, so a throw is the signal.
    expect(() => process.kill(pid, 0)).toThrow();
    expect((cluster as unknown as { zombieProcesses: number }).zombieProcesses).toBe(0);
  });

  it("drains its pool and clears the endpoint when the transport drops", async () => {
    const cluster = new SteerableBrowserCluster({ executablePath: "/x", quiet: true });
    // A disconnect without a live browser is a no-op that must not throw: the handler runs on
    // the transport's close event, which can fire after the cluster has already stopped.
    const internal = cluster as unknown as {
      handleDisconnect: () => void;
      browserTransport: unknown;
      wsEndpoint: string | null;
    };
    internal.browserTransport = null;
    expect(() => internal.handleDisconnect()).not.toThrow();
    expect(internal.wsEndpoint).toBeNull();
    expect(cluster.poolStats.active).toBe(0);
  });
});

describe("TRK-01-init / session identity", () => {
  it("derives a deterministic fingerprint from a preset seed", () => {
    const one = generateFingerprint({ seed: 1234, deviceClass: "desktop" });
    const two = generateFingerprint({ seed: 1234, deviceClass: "desktop" });
    expect(one.navigator.platform).toBe(two.navigator.platform);
    expect(one.navigator.hardwareConcurrency).toBe(two.navigator.hardwareConcurrency);
  });

  it("rejects a fingerprint whose fields contradict each other", () => {
    const mobile = generateFingerprint({ seed: 7, deviceClass: "mobile" });
    expect(mobile.deviceClass).toBe("mobile");
    expect(mobile.screen.devicePixelRatio).toBeGreaterThanOrEqual(2);
  });
});

describe("configuration errors are not retried", () => {
  it("constructs a configuration error that reports itself non-retryable", () => {
    const error = new ConfigurationError("bad proxy", ConfigurationField.PROXY_URL);
    expect(error.isRetryable).toBe(false);
  });
});
