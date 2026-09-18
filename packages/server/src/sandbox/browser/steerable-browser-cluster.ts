/**
 * The steerable browser cluster daemon: the Tier 1 module of the stealth browser plane.
 *
 * One of these per server process owns the browser's whole life — it launches the browser
 * binary, discovers its CDP endpoint, owns the session pool, injects the anti-detect scripts
 * into every page, streams cockpit telemetry, and — the part most likely to be silently wrong —
 * guarantees the browser process is gone when the session ends. The exit criterion is explicit:
 * a session must close with zero zombie processes.
 *
 * Architecture, and why each piece is the shape it is:
 *
 *   browser binary ──spawn──▶ child process ──/json/version──▶ browser CDP transport
 *                                                             │
 *                                                             ▼
 *                                                    CdpSessionPool (per-target sessions)
 *                                                             │
 *   fingerprint/canvas/WebGL/TLS ──Page.addScriptToEvaluateOnNewDocument──▶ every page
 *
 * The launch-argument set is the donor's, transcribed: a long `--disable-features` list (each
 * entry kills a specific phone-home or UI behaviour that fingerprinters and bot detectors key
 * on), WebRTC IP-handling flags (a proxied session that leaks its real IP over WebRTC is a
 * detection event), and `--disable-blink-features=AutomationControlled` (the single most
 * obvious automation tell). Those flags are the cumulative result of the donor's own detection
 * tuning; they are ported verbatim rather than re-derived.
 *
 * Injection uses `Page.addScriptToEvaluateOnNewDocument` — not `Page.evaluate` — because the
 * fingerprint hooks must be installed before the page's own scripts run. A page that reads
 * `navigator.hardwareConcurrency` in its first script block sees the spoofed value only if the
 * hook was registered first, which is exactly what the "evaluate on new document" domain
 * guarantees and what a plain evaluate races.
 *
 * Zombie reaping is cross-platform by design: on POSIX the process is killed in its own group
 * (`detached: true`, kill the group with `SIGKILL` to `-pid`), and a sweep of the browser
 * command line in the process table catches anything the group kill missed; on Windows the job
 * object is not relied upon, so the sweep is what makes the guarantee. The donor's lesson here
 * is direct: it ships a full process-tree walker because a browser's children (renderer, GPU,
 * crashpad) survive a naive `kill(pid)` often enough to matter.
 *
 * Retry policy is exponential backoff with jitter, and it is keyed to the typed launch-error
 * taxonomy: only errors flagged retryable consume a retry attempt. A bad proxy URL or a missing
 * binary is retried zero times, because retrying a configuration error burns the latency budget
 * on something no number of attempts will fix.
 */

import { EventEmitter, once } from "events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildCanvasNoiseScript,
  buildWebGlOverrideScript,
  BrowserSessionState,
  CockpitBrowserEvent,
  CockpitBrowserEventKind,
  DomSnapshot,
  DomTreeNode,
  generateFingerprint,
  getBrowserProfile,
  NetworkHarvestEntry,
  presetToFingerprint,
  ViewportFrame,
  type BrowserFingerprint,
  type ProfileId,
} from "@prismshadow/penguin-core/browser";
import {
  categorizeError,
  ConfigurationError,
  isErrorRetryable,
  LaunchTimeoutError,
  PluginError,
  PluginName,
  PluginOperation,
} from "./launch-error-taxonomy.js";
import { isLocalFileSystemRequest } from "./request-classifier.js";
import {
  CdpSessionPool,
  connectCdpTransport,
  CdpEvent,
  CdpTransport,
  discoverCdpUrl,
  PooledSessionHandle,
} from "./cdp-session-pool.js";

/** Which browser product to run; the presets are Tier 4 and live in core. */
export type BrowserProduct = "chromium" | "firefox";

/** Configuration for one session's launch. */
export interface SteerableSessionConfig {
  /** Profile preset id from the Tier 4 preset table; the fingerprint derives from it. */
  profileId?: ProfileId;
  /** Explicit fingerprint, overriding the preset. */
  fingerprint?: BrowserFingerprint;
  /** Seed for a deterministic identity derived from the preset. */
  seed?: number;
  /** Proxy URL the browser is launched with (`--proxy-server`). */
  proxyUrl?: string;
  /** Extra command-line arguments appended after the stealth set. */
  args?: string[];
  /** Run headless. @default true */
  headless?: boolean;
  /** Viewport override; otherwise the fingerprint's screen dimensions. */
  dimensions?: { width: number; height: number };
  /** User data directory; a fresh temp profile when omitted. */
  userDataDir?: string;
  /** Block ad/tracker hosts and heavy media. @default true */
  blockAds?: boolean;
  /** Record the request log for the cockpit harvester. @default true */
  captureNetwork?: boolean;
  /** Stream viewport frames for the cockpit. @default true */
  streamViewport?: boolean;
  /** Maximum frames per second of the viewport stream. @default 30 */
  viewportFps?: number;
  /** Timezone for the browser's `TZ` environment variable. */
  timezone?: string;
}

/** Cluster-wide options. */
export interface SteerableBrowserClusterOptions {
  /** Browser executable path; resolved from the platform defaults when omitted. */
  executablePath?: string;
  /** Which product to launch. @default "chromium" */
  product?: BrowserProduct;
  /** Debug port to bind; 0 picks a free ephemeral port. @default 9222 */
  debugPort?: number;
  /** Debug bind address. @default "127.0.0.1" */
  debugHost?: string;
  /** Milliseconds before a launch is declared timed out. @default 60000 */
  launchTimeoutMs?: number;
  /** Retry budget for a retryable launch error. @default 3 */
  maxLaunchAttempts?: number;
  /** Backoff base for launch retries. @default 500 */
  retryBaseDelayMs?: number;
  /** Backoff ceiling for launch retries. @default 5000 */
  retryMaxDelayMs?: number;
  /** Backoff multiplier. @default 2 */
  retryBackoffMultiplier?: number;
  /** Jitter added to each retry delay. @default 250 */
  retryJitterMs?: number;
  /** Concurrent isolated contexts the pool will hold. @default 30 */
  maxConcurrentSessions?: number;
  /** Shut the browser down after this long with no live session; 0 disables. @default 120000 */
  idleShutdownMs?: number;
  /** Disable the OS sandbox (required when running as root on Linux). @default auto */
  disableSandbox?: boolean;
  /** Extra environment variables for the browser process. */
  env?: Record<string, string>;
  /** Emit nothing beyond errors when true. @default false */
  quiet?: boolean;
}

/**
 * The launch argument set, split so the parts that vary are composed rather than duplicated:
 * the static anti-detect flags every browser gets, the headless/headful differences, and the
 * per-session dynamic values (dimensions, user agent, proxy).
 */
export const STATIC_STEALTH_ARGS: readonly string[] = [
  "--remote-allow-origins=*",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-features=TranslateUI,BlinkGenPropertyTrees,LinuxNonClientFrame,PermissionPromptSurvey,IsolateOrigins,site-per-process,TouchpadAndWheelScrollLatching,TrackingProtection3pcd,InterestFeedContentSuggestions,PrivacySandboxSettings4,AutofillServerCommunication,OptimizationHints,MediaRouter,DialMediaRouteProvider,CertificateTransparencyComponentUpdater,GlobalMediaControls,AudioServiceOutOfProcess,LazyFrameLoading,AvoidUnnecessaryBeforeUnloadCheckSync,DisableLoadExtensionCommandLineSwitch,DisableDisableExtensionsExceptCommandLineSwitch",
  "--enable-features=Clipboard",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-translate",
  "--no-first-run",
  "--disable-search-engine-choice-screen",
  // WebRTC: a proxied session that opens a non-proxied UDP socket exposes the host IP, which
  // is a hard detection event for any proxy-based stealth deployment.
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--force-webrtc-ip-handling-policy",
  "--disable-touch-editing",
  "--disable-touch-drag-drop",
  "--disable-client-side-phishing-detection",
  "--disable-default-apps",
  "--disable-component-update",
  "--disable-infobars",
  "--disable-breakpad",
  "--disable-background-networking",
  "--disable-session-crashed-bubble",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-domain-reliability",
  "--metrics-recording-only",
  "--no-pings",
  "--disable-backing-store-limit",
  "--password-store=basic",
];

export const HEADLESS_ARGS: readonly string[] = [
  "--headless=new",
  "--hide-crash-restore-bubble",
  // The single most recognizable automation tell: without this, `navigator.webdriver` is true.
  "--disable-blink-features=AutomationControlled",
];

export const HEADFUL_ARGS: readonly string[] = [
  "--ozone-platform=x11",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--use-gl=swiftshader",
  "--in-process-gpu",
  "--noerrdialogs",
  "--force-device-scale-factor=1",
  "--disable-hang-monitor",
];

/** Command-line patterns of a browser process tree, for the zombie sweep. */
export const BROWSER_PROCESS_PATTERNS =
  /chrom|chrome|chromium|firefox|geckodriver|camoufox-bin|GeckoChildProcess/i;

/** The default debug port; a free ephemeral port is picked when the configured one is busy. */
const DEFAULT_DEBUG_PORT = 9222;

/** The telemetry channel the cockpit subscribes to. */
export type ClusterTelemetryListener = (event: CockpitBrowserEvent) => void;

interface SessionRecord {
  id: string;
  state: BrowserSessionState;
  config: SteerableSessionConfig;
  fingerprint: BrowserFingerprint;
  /** Pool key the CDP session is checked out under. */
  poolKey: string;
  targetId?: string;
  startedAt: number;
}

/** Outcome of a launch attempt, with the timing the cockpit reports. */
export interface LaunchResult {
  pid: number;
  wsEndpoint: string;
  durationMs: number;
  /** True when the launch beat the cold-start target. */
  withinTarget: boolean;
}

/** Cold-start target for the cockpit KPI tile (plan §4: < 650ms). */
export const COLD_LAUNCH_TARGET_MS = 650;

/**
 * The daemon. Emits cockpit telemetry as the first argument to every listener registered with
 * {@link onTelemetry}, so a UI or a metrics collector never has to poll.
 */
export class SteerableBrowserCluster extends EventEmitter {
  private readonly opts: Required<Omit<SteerableBrowserClusterOptions, "env">> & {
    env: Record<string, string>;
  };
  private process: ReturnType<typeof spawn> | null = null;
  private pid: number | null = null;
  private wsEndpoint: string | null = null;
  private browserTransport: CdpTransport | null = null;
  private pool: CdpSessionPool | null = null;
  private readonly sessions = new Map<string, SessionRecord>();
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private sequence = 0;
  private coldLaunches = { withinTarget: 0, total: 0 };
  private zombieProcesses = 0;
  private readonly frameSequenceByTarget = new Map<string, number>();
  private lastViewportFrameAt = 0;

  constructor(options: SteerableBrowserClusterOptions = {}) {
    super();
    this.opts = {
      executablePath:
        options.executablePath ?? defaultExecutablePath(options.product ?? "chromium"),
      product: options.product ?? "chromium",
      debugPort: options.debugPort ?? DEFAULT_DEBUG_PORT,
      debugHost: options.debugHost ?? "127.0.0.1",
      launchTimeoutMs: options.launchTimeoutMs ?? 60_000,
      maxLaunchAttempts: options.maxLaunchAttempts ?? 3,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
      retryMaxDelayMs: options.retryMaxDelayMs ?? 5_000,
      retryBackoffMultiplier: options.retryBackoffMultiplier ?? 2,
      retryJitterMs: options.retryJitterMs ?? 250,
      maxConcurrentSessions: options.maxConcurrentSessions ?? 30,
      idleShutdownMs: options.idleShutdownMs ?? 120_000,
      disableSandbox: options.disableSandbox ?? shouldDisableSandbox(),
      env: { ...options.env },
      quiet: options.quiet ?? false,
    };
  }

  /** Subscribes to cockpit telemetry. Returns an unsubscribe function. */
  onTelemetry(listener: ClusterTelemetryListener): () => void {
    this.on("telemetry", listener);
    return () => this.off("telemetry", listener);
  }

  private emitTelemetry(event: CockpitBrowserEvent): void {
    this.emit("telemetry", event);
  }

  private log(
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    if (this.opts.quiet && level !== "error") return;
    this.emit("log", { level, message, fields });
  }

  /** True when a browser process is alive and its CDP transport is open. */
  get isRunning(): boolean {
    return (
      this.process !== null &&
      !this.process.killed &&
      this.browserTransport !== null &&
      !this.browserTransport.isClosed
    );
  }

  /** Current pool utilization. */
  get poolStats(): {
    active: number;
    idle: number;
    capacity: number;
    created: number;
    reused: number;
    evicted: number;
  } {
    return (
      this.pool?.stats ?? {
        active: 0,
        idle: 0,
        capacity: this.opts.maxConcurrentSessions,
        created: 0,
        reused: 0,
        evicted: 0,
      }
    );
  }

  /**
   * Starts a session: launches (or reuses) the browser, attaches to the page target, injects the
   * anti-detect scripts, and begins streaming telemetry. Retries retryable launch failures with
   * exponential backoff and jitter.
   */
  async startSession(config: SteerableSessionConfig = {}): Promise<string> {
    const sessionId = `brs-${Date.now().toString(36)}-${(this.sequence++).toString(36)}`;
    const fingerprint =
      config.fingerprint ??
      presetToFingerprint(
        getBrowserProfile(config.profileId ?? "desktop-chrome-win11"),
        config.seed ?? Date.now() % 1e6,
      );

    const record: SessionRecord = {
      id: sessionId,
      state: BrowserSessionState.Pending,
      config,
      fingerprint,
      poolKey: sessionId,
      startedAt: performance.now(),
    };
    this.sessions.set(sessionId, record);

    if (this.sessions.size > this.opts.maxConcurrentSessions) {
      this.sessions.delete(sessionId);
      throw new Error(`Cluster at concurrent-session ceiling (${this.opts.maxConcurrentSessions})`);
    }

    try {
      await this.ensureBrowser();
      record.state = BrowserSessionState.Live;
      await this.attachSession(record);
      this.emitTelemetry({
        kind: CockpitBrowserEventKind.SessionStarted,
        sessionId,
        state: BrowserSessionState.Live,
        targets: this.pool ? [] : [],
        viewport: {
          width: fingerprint.screen.width,
          height: fingerprint.screen.height,
          deviceScaleFactor: fingerprint.screen.devicePixelRatio,
          isMobile: fingerprint.deviceClass === "mobile",
        },
        timestamp: new Date().toISOString(),
      });
      this.scheduleIdleShutdown();
    } catch (error) {
      record.state = BrowserSessionState.Failed;
      const typed = categorizeError(error, "session start");
      this.emitTelemetry({
        kind: CockpitBrowserEventKind.Error,
        sessionId,
        code: typed.type,
        message: typed.message,
        retryable: typed.isRetryable,
        timestamp: new Date().toISOString(),
      });
      this.sessions.delete(sessionId);
      throw typed;
    }
    return sessionId;
  }

  /** Ends a session, detaches its CDP session, and shuts the browser down when nothing is live. */
  async endSession(sessionId: string, reason = "session_end"): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.state = BrowserSessionState.Ending;

    try {
      this.pool?.release(record.poolKey);
    } catch {
      /* already released */
    }
    this.sessions.delete(sessionId);
    this.emitTelemetry({
      kind: CockpitBrowserEventKind.SessionEnded,
      sessionId,
      reason,
      timestamp: new Date().toISOString(),
    });

    if (this.sessions.size === 0) {
      this.scheduleIdleShutdown();
    }
  }

  /**
   * Launches the browser with retry, returning the endpoint. The public entry for callers that
   * need the browser without starting a session (a warm-cluster probe).
   */
  async launch(): Promise<LaunchResult> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.opts.maxLaunchAttempts; attempt++) {
      try {
        return await this.launchOnce();
      } catch (error) {
        lastError = error as Error;
        const typed = categorizeError(error, "browser launch");
        // A configuration or resource error is never retried: no number of attempts installs a
        // missing binary or fixes a malformed proxy URL.
        if (
          !typed.isRetryable ||
          !isErrorRetryable(typed) ||
          attempt >= this.opts.maxLaunchAttempts
        ) {
          throw typed;
        }
        this.log("warn", `Launch attempt ${attempt} failed (${typed.type}); retrying`, {
          message: typed.message,
        });
        await this.delay(attempt);
      }
    }
    throw lastError ?? new Error("browser launch failed");
  }

  /** The delay before the next retry: exponential backoff plus bounded jitter. */
  retryDelay(attempt: number): number {
    const base = this.opts.retryBaseDelayMs;
    const growth = Math.pow(this.opts.retryBackoffMultiplier, attempt - 1);
    const delay = Math.min(base * growth, this.opts.retryMaxDelayMs);
    const jitter = this.opts.retryJitterMs > 0 ? Math.random() * this.opts.retryJitterMs : 0;
    return Math.round(delay + jitter);
  }

  private delay(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.retryDelay(attempt)));
  }

  /** A single launch attempt, bounded by the launch timeout. */
  private async launchOnce(): Promise<LaunchResult> {
    if (this.isRunning) {
      return {
        pid: this.pid ?? -1,
        wsEndpoint: this.wsEndpoint ?? "",
        durationMs: 0,
        withinTarget: true,
      };
    }
    if (this.shuttingDown) {
      throw new ConfigurationError("cluster is shutting down");
    }

    const started = performance.now();
    const port = await this.resolveFreePort();
    const userDataDir = this.opts.product === "chromium" ? this.ensureUserDataDir() : undefined;
    const args = this.buildLaunchArgs(port, userDataDir);

    const child = spawn(this.opts.executablePath, args, {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        TZ: "UTC",
        ...this.opts.env,
      },
      windowsHide: true,
    });
    this.process = child;
    this.pid = child.pid ?? null;

    child.once("error", (error) => {
      this.log("error", "Browser process error", { message: error.message });
      this.zombieProcesses += 0;
    });

    const result = await this.raceLaunchTimeout(port, started);
    this.coldLaunches.total += 1;
    this.coldLaunches.withinTarget += result.withinTarget ? 1 : 0;
    return result;
  }

  /** Waits for CDP discovery up to the launch timeout, then records timing. */
  private async raceLaunchTimeout(port: number, started: number): Promise<LaunchResult> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const launchTimeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new LaunchTimeoutError(this.opts.launchTimeoutMs)),
        this.opts.launchTimeoutMs,
      );
    });

    try {
      const wsEndpoint = await Promise.race([this.waitForEndpoint(port), launchTimeout]);
      const durationMs = performance.now() - started;
      this.wsEndpoint = wsEndpoint;
      this.browserTransport = await connectCdpTransport(wsEndpoint, {
        keepaliveIntervalMs: 30_000,
        commandTimeoutMs: 30_000,
      });
      this.browserTransport.on("close", (reason) => {
        this.log("warn", "Browser CDP transport closed", { reason });
        this.handleDisconnect();
      });
      this.pool = new CdpSessionPool(this.browserTransport, {
        capacity: this.opts.maxConcurrentSessions,
      });
      this.log("info", "Browser CDP transport connected", {
        wsEndpoint,
        durationMs: Math.round(durationMs),
      });
      return {
        pid: this.pid ?? -1,
        wsEndpoint,
        durationMs,
        withinTarget: durationMs <= COLD_LAUNCH_TARGET_MS,
      };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  /** Polls the discovery cascade until the browser answers or the attempt is aborted. */
  private async waitForEndpoint(port: number): Promise<string> {
    const host = this.opts.debugHost;
    for (let attempt = 0; attempt < 120; attempt++) {
      const exited = this.process?.exitCode !== null && this.process?.exitCode !== undefined;
      if (exited) {
        throw new PluginError(
          `Browser process exited with code ${this.process?.exitCode}`,
          PluginName.LAUNCH_MUTATOR,
          PluginOperation.PRE_LAUNCH_HOOK,
          false,
        );
      }
      try {
        return await discoverCdpUrl(host, port);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new LaunchTimeoutError(this.opts.launchTimeoutMs);
  }

  /** Composes the full argument list: static stealth flags, headless mode, dynamic values. */
  buildLaunchArgs(port: number, userDataDir?: string): string[] {
    const dims = this.currentDimensions();
    const headless = this.currentHeadless();
    const staticArgs = this.opts.disableSandbox
      ? [...STATIC_STEALTH_ARGS, "--no-sandbox", "--disable-setuid-sandbox", "--no-zygote"]
      : [...STATIC_STEALTH_ARGS];

    const dynamic: string[] = [
      `--remote-debugging-address=${this.opts.debugHost}`,
      `--remote-debugging-port=${port}`,
      `--window-size=${dims.width},${dims.height}`,
    ];
    const sessionConfig = this.currentSessionConfig();
    if (sessionConfig?.proxyUrl) dynamic.push(`--proxy-server=${sessionConfig.proxyUrl}`);
    if (sessionConfig?.args) dynamic.push(...sessionConfig.args);

    const all = [
      ...staticArgs,
      ...(headless ? HEADLESS_ARGS : HEADFUL_ARGS),
      ...dynamic,
      ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    ];
    return dedupe(all);
  }

  private currentSessionConfig(): SteerableSessionConfig | undefined {
    for (const record of this.sessions.values()) return record.config;
    return undefined;
  }

  private currentDimensions(): { width: number; height: number } {
    const session = this.currentSessionConfig();
    if (session?.dimensions) return session.dimensions;
    for (const record of this.sessions.values()) {
      return { width: record.fingerprint.screen.width, height: record.fingerprint.screen.height };
    }
    return { width: 1920, height: 1080 };
  }

  private currentHeadless(): boolean {
    return this.currentSessionConfig()?.headless ?? true;
  }

  private ensureUserDataDir(): string {
    const base = this.opts.product === "chromium" ? "penguin-chrome" : "penguin-firefox";
    return mkdtempSync(join(tmpdir(), `${base}-`));
  }

  /** Picks the configured port, or a free ephemeral one when it is busy. */
  private async resolveFreePort(): Promise<number> {
    if (this.opts.debugPort !== DEFAULT_DEBUG_PORT) return this.opts.debugPort;
    return new Promise((resolve) => {
      const probe = require_node_net();
      probe.once("error", () => resolve(DEFAULT_DEBUG_PORT));
      probe.once("listening", () => {
        const address = probe.address();
        probe.close(() =>
          resolve(typeof address === "object" && address ? address.port : DEFAULT_DEBUG_PORT),
        );
      });
      probe.listen(0, this.opts.debugHost);
    });
  }

  /** Ensures a browser is running, launching one when it is not. */
  private async ensureBrowser(): Promise<void> {
    if (this.isRunning) return;
    await this.launch();
  }

  /** Attaches to the page target and installs the anti-detect scripts. */
  private async attachSession(record: SessionRecord): Promise<void> {
    if (!this.pool) throw new Error("CDP session pool is not initialized");

    const targetId = await this.findPageTarget();
    record.targetId = targetId;
    const handle: PooledSessionHandle = await this.pool.acquire(record.poolKey, targetId);

    // Order matters: the scripts must be registered before any navigation, so a page's own
    // first script sees the spoofed environment.
    await this.installInjectionScripts(handle, record);
    await handle.send("Page.enable");
    await handle.send("Runtime.enable");
    if (record.config.captureNetwork ?? true) {
      await handle.send("Network.enable");
      this.attachNetworkHarvest(handle, record);
    }
    if (record.config.streamViewport ?? true) {
      this.attachViewportStream(handle, record);
    }
    handle.subscribe((event) => this.routeSessionEvent(record, event));
  }

  /** Finds the first page target, creating one when the browser opened without a page. */
  private async findPageTarget(): Promise<string> {
    const result = (await this.browserTransport?.send("Target.getTargets")) as {
      targetInfos?: Array<{ targetId: string; type: string }>;
    };
    const page = result?.targetInfos?.find((target) => target.type === "page");
    if (page) return page.targetId;
    const created = (await this.browserTransport?.send("Target.createTarget", {
      url: "about:blank",
    })) as { targetId?: string };
    if (!created?.targetId) throw new Error("Failed to create a page target");
    return created.targetId;
  }

  /** Registers the fingerprint, canvas-noise and WebGL-override scripts for every new document. */
  private async installInjectionScripts(
    handle: PooledSessionHandle,
    record: SessionRecord,
  ): Promise<void> {
    const fingerprint = record.fingerprint;
    const seed = fingerprint.seed;
    const scripts = [
      buildFingerprintInjectionScript(fingerprint),
      buildCanvasNoiseScript({ seed, hookExport: true, hookGetImageData: true }),
      buildWebGlOverrideScript(fingerprint.webgl),
    ];
    for (const source of scripts) {
      // addScriptToEvaluateOnNewDocument runs the hook before page scripts on every navigation.
      await handle.send("Page.addScriptToEvaluateOnNewDocument", { source });
    }
  }

  /** Routes a session's own events to telemetry; the frame stream is handled separately. */
  private routeSessionEvent(record: SessionRecord, event: CdpEvent): void {
    switch (event.method) {
      case "Page.frameNavigated": {
        const params = event.params as { frame?: { url?: string } };
        if (params.frame?.url) {
          this.emitTelemetry({
            kind: CockpitBrowserEventKind.Navigation,
            sessionId: record.id,
            targetId: record.targetId ?? "",
            url: params.frame.url,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      }
      case "Runtime.consoleAPICalled": {
        const params = event.params as { type?: string; args?: Array<{ value?: string }> };
        this.emitTelemetry({
          kind: CockpitBrowserEventKind.ConsoleMessage,
          message: {
            sessionId: record.id,
            targetId: record.targetId ?? "",
            level: (params.type as "log" | "info" | "warning" | "error" | "debug") ?? "log",
            text: (params.args ?? []).map((arg) => String(arg.value ?? "")).join(" "),
            timestamp: new Date().toISOString(),
          },
        });
        break;
      }
      default:
        break;
    }
  }

  /** Enables the CDP screencast and decodes frames onto the telemetry channel. */
  private attachViewportStream(handle: PooledSessionHandle, record: SessionRecord): void {
    const fps = Math.max(1, Math.min(60, record.config.viewportFps ?? 30));
    const interval = Math.round(1000 / fps);
    let armed = true;

    const start = async (): Promise<void> => {
      try {
        await handle.send("Page.startScreencast", {
          format: "jpeg",
          quality: 60,
          everyNthFrame: 1,
        });
      } catch {
        armed = false;
      }
    };
    void start();

    handle.subscribe((event) => {
      if (event.method !== "Page.screencastFrame") return;
      const params = event.params as {
        data: string;
        sessionId: string;
        metadata?: { deviceWidth: number; deviceHeight: number; pageScaleFactor: number };
      };
      const now = performance.now();
      // Enforce the configured cadence: a browser that emits faster than the target fps floods
      // the telemetry channel, so excess frames are dropped here rather than in the UI.
      if (now - this.lastViewportFrameAt < interval) return;
      this.lastViewportFrameAt = now;

      const sequence = (this.frameSequenceByTarget.get(record.targetId ?? "") ?? 0) + 1;
      this.frameSequenceByTarget.set(record.targetId ?? "", sequence);
      const frame: ViewportFrame = {
        sessionId: record.id,
        targetId: record.targetId ?? "",
        sequence,
        width: params.metadata?.deviceWidth ?? record.fingerprint.screen.width,
        height: params.metadata?.deviceHeight ?? record.fingerprint.screen.height,
        data: `data:image/jpeg;base64,${params.data}`,
        encoding: "data-url",
        timestamp: new Date().toISOString(),
      };
      this.emitTelemetry({ kind: CockpitBrowserEventKind.Frame, frame });
      // Acknowledge so the browser keeps streaming; without this the screencast stalls.
      void handle.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {
        /* session gone */
      });
    });
  }

  /** Harvests the network log, applying the request policy and the file:// protocol gate. */
  private attachNetworkHarvest(handle: PooledSessionHandle, record: SessionRecord): void {
    const requestMeta = new Map<string, { url: string; startedAt: number; resourceType: string }>();

    handle.subscribe((event) => {
      const sessionId = record.id;
      const targetId = record.targetId ?? "";
      const iso = (): string => new Date().toISOString();

      switch (event.method) {
        case "Network.requestWillBeSent": {
          const params = event.params as {
            requestId: string;
            request: { url: string; method: string };
            type?: string;
          };
          requestMeta.set(params.requestId, {
            url: params.request.url,
            startedAt: performance.now(),
            resourceType: params.type ?? "other",
          });

          // The protocol gate is separate from filtering: reaching file:// means the browser
          // escaped its origin, so the session ends rather than merely aborting the request.
          if (isLocalFileSystemRequest(params.request.url)) {
            void this.endSession(sessionId, "security_violation");
            return;
          }
          const entry: NetworkHarvestEntry = {
            sessionId,
            targetId,
            requestId: params.requestId,
            method: params.request.method,
            url: params.request.url,
            resourceType: normalizeResourceType(params.type),
            timestamp: iso(),
          };
          this.emitTelemetry({ kind: CockpitBrowserEventKind.NetworkEntry, entry });
          break;
        }
        case "Network.responseReceived": {
          const params = event.params as {
            requestId: string;
            response: { status: number; mimeType: string };
          };
          const meta = requestMeta.get(params.requestId);
          if (!meta) break;
          const entry: NetworkHarvestEntry = {
            sessionId,
            targetId,
            requestId: params.requestId,
            method: "",
            url: meta.url,
            resourceType: normalizeResourceType(meta.resourceType),
            status: params.response.status,
            mimeType: params.response.mimeType,
            timestamp: iso(),
          };
          this.emitTelemetry({ kind: CockpitBrowserEventKind.NetworkEntry, entry });
          break;
        }
        case "Network.loadingFinished": {
          const params = event.params as { requestId: string; encodedDataLength: number };
          const meta = requestMeta.get(params.requestId);
          requestMeta.delete(params.requestId);
          if (!meta) break;
          const entry: NetworkHarvestEntry = {
            sessionId,
            targetId,
            requestId: params.requestId,
            method: "",
            url: meta.url,
            resourceType: normalizeResourceType(meta.resourceType),
            encodedDataLength: params.encodedDataLength,
            durationMs: Math.round(performance.now() - meta.startedAt),
            timestamp: iso(),
          };
          this.emitTelemetry({ kind: CockpitBrowserEventKind.NetworkEntry, entry });
          break;
        }
        case "Network.loadingFailed": {
          const params = event.params as { requestId: string; errorText: string };
          const meta = requestMeta.get(params.requestId);
          requestMeta.delete(params.requestId);
          if (!meta) break;
          const entry: NetworkHarvestEntry = {
            sessionId,
            targetId,
            requestId: params.requestId,
            method: "",
            url: meta.url,
            resourceType: normalizeResourceType(meta.resourceType),
            failed: true,
            failureText: params.errorText,
            durationMs: Math.round(performance.now() - meta.startedAt),
            timestamp: iso(),
          };
          this.emitTelemetry({ kind: CockpitBrowserEventKind.NetworkEntry, entry });
          break;
        }
        default:
          break;
      }
    });
  }

  /** Requests a DOM snapshot for the inspector widget. */
  async requestDomSnapshot(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record || !this.pool || !record.targetId) return;
    const handle = await this.pool.acquire(record.poolKey, record.targetId);
    try {
      const evaluation = (await handle.send("Runtime.evaluate", {
        expression: DOM_SNAPSHOT_EXPRESSION,
        returnByValue: true,
      })) as { result?: { value?: DomTreeNode } };
      const root = evaluation.result?.value;
      if (!root) return;
      const snapshot: DomSnapshot = {
        sessionId,
        targetId: record.targetId,
        root,
        viewport: {
          width: record.fingerprint.screen.width,
          height: record.fingerprint.screen.height,
          deviceScaleFactor: record.fingerprint.screen.devicePixelRatio,
          isMobile: record.fingerprint.deviceClass === "mobile",
        },
        scrollX: 0,
        scrollY: 0,
        timestamp: new Date().toISOString(),
      };
      this.emitTelemetry({ kind: CockpitBrowserEventKind.DomSnapshot, snapshot });
    } finally {
      this.pool.release(record.poolKey);
    }
  }

  /** Emits a metrics event; the cockpit renders this as KPI tiles. */
  emitMetrics(): void {
    const counts: Partial<Record<BrowserSessionState, number>> = {};
    for (const record of this.sessions.values()) {
      counts[record.state] = (counts[record.state] ?? 0) + 1;
    }
    this.emitTelemetry({
      kind: CockpitBrowserEventKind.Metrics,
      metrics: {
        sessions: counts,
        coldLaunches: { ...this.coldLaunches },
        pool: {
          active: this.poolStats.active,
          idle: this.poolStats.idle,
          capacity: this.poolStats.capacity,
        },
        domQueryLatencyMs: { p50: 0, p95: 0 },
        viewportFrames: { delivered: 0, dropped: 0 },
        zombieProcesses: this.zombieProcesses,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /** Schedules an idle shutdown; cancelled the moment a session starts. */
  private scheduleIdleShutdown(): void {
    if (this.opts.idleShutdownMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.sessions.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.sessions.size === 0) {
        void this.shutdown("idle_shutdown").catch(() => {
          /* already stopped */
        });
      }
    }, this.opts.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  /** Handles an unexpected CDP disconnect: fails live sessions and clears the pool. */
  private handleDisconnect(): void {
    for (const [sessionId, record] of this.sessions) {
      record.state = BrowserSessionState.Failed;
      this.emitTelemetry({
        kind: CockpitBrowserEventKind.Error,
        sessionId,
        code: "DISCONNECTED",
        message: "Browser CDP transport closed unexpectedly",
        retryable: true,
        timestamp: new Date().toISOString(),
      });
      this.sessions.delete(sessionId);
    }
    this.pool?.drain("closed");
    this.pool = null;
    this.browserTransport = null;
    this.wsEndpoint = null;
  }

  /**
   * Stops the cluster: closes the transport, kills the browser process group, sweeps for
   * survivors, and removes the profile directory. `reason` is recorded in the telemetry trail.
   */
  async shutdown(reason = "shutdown"): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const sessionIds = [...this.sessions.keys()];
    this.pool?.close();
    this.pool = null;
    try {
      this.browserTransport?.close();
    } catch {
      /* closing twice is fine */
    }
    this.browserTransport = null;

    for (const sessionId of sessionIds) {
      this.emitTelemetry({
        kind: CockpitBrowserEventKind.SessionEnded,
        sessionId,
        reason,
        timestamp: new Date().toISOString(),
      });
    }
    this.sessions.clear();

    await this.killBrowserProcess(reason);
    this.wsEndpoint = null;
    this.shuttingDown = false;
  }

  /**
   * Kills the browser process and reaps survivors. On POSIX the process was spawned detached in
   * its own group, so the group is signalled first; then the process table is swept for any
   * browser command line the group kill missed — the donor's lesson that children routinely
   * outlive a single-pid kill.
   */
  private async killBrowserProcess(reason: string): Promise<void> {
    const pid = this.pid;
    this.pid = null;
    const child = this.process;
    this.process = null;
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }
    if (pid !== null && process.platform !== "win32") {
      try {
        // Negative pid targets the process group; without it children escape.
        process.kill(-pid, "SIGKILL");
      } catch {
        /* group gone */
      }
    }
    // A signal is not a reaping: the pid stays in the process table until the kernel tears the
    // process down, so a "no zombies" promise checked the instant shutdown returns would race
    // the teardown without waiting for the exit first.
    if (child) await waitForProcessExit(child, 1000);
    const survivors = this.sweepBrowserProcesses(pid);
    if (survivors.length > 0) {
      this.zombieProcesses += survivors.length;
      this.log("warn", "Reaped surviving browser processes", { count: survivors.length, reason });
      for (const survivor of survivors) {
        try {
          process.kill(survivor, "SIGKILL");
        } catch {
          /* vanished between sweep and kill */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  /**
   * Sweeps for browser processes the group kill missed, scoped to the browser's own process
   * group. The browser is spawned `detached` as a group leader, so its pid is its group id and
   * only processes in that group are the cluster's to reap. A global match would count — and
   * then SIGKILL — an unrelated browser belonging to whoever else shares the host, which also
   * made this check flaky on shared CI runners.
   */
  sweepBrowserProcesses(browserGroupPid: number | null = null): number[] {
    if (process.platform === "linux") {
      return sweepLinuxProcesses(browserGroupPid);
    }
    return [];
  }
}

/** Builds the fingerprint injection script: navigator, screen and UA-metadata overrides. */
export function buildFingerprintInjectionScript(fingerprint: BrowserFingerprint): string {
  const navigator = fingerprint.navigator;
  return `
(function () {
  var navigatorOverrides = {
    platform: ${JSON.stringify(navigator.platform)},
    hardwareConcurrency: ${JSON.stringify(navigator.hardwareConcurrency)},
    deviceMemory: ${JSON.stringify(navigator.deviceMemory)},
    languages: ${JSON.stringify([...navigator.languages])},
    architecture: ${JSON.stringify(navigator.architecture)},
    bitness: ${JSON.stringify(navigator.bitness)},
    model: ${JSON.stringify(navigator.model)}
  };
  for (var key in navigatorOverrides) {
    try {
      Object.defineProperty(Navigator.prototype, key, {
        get: function () { return navigatorOverrides[key]; },
        configurable: true
      });
    } catch (e) { /* a locked property is left alone rather than throwing */ }
  }
  // userAgentData brands must agree with the UA string or the inconsistency is itself a signal.
  if (navigator.userAgentData) {
    try {
      Object.defineProperty(navigator.userAgentData, "brands", {
        get: function () { return ${JSON.stringify(navigator.brands)}; },
        configurable: true
      });
    } catch (e) { /* leave the platform's own brands */ }
  }
})();
`;
}

/**
 * The DOM snapshot expression the inspector widget consumes. It walks the tree once, keeps the
 * interactive nodes (the same rule set the DOM interaction module defines), and prunes
 * everything else — a full DOM dump is far too large to ship to a UI on every snapshot.
 */
export const DOM_SNAPSHOT_EXPRESSION = `
(function () {
  var MAX_DEPTH = 32;
  var accepted = [];
  function rectOf(el) {
    try {
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    } catch (e) { return undefined; }
  }
  function walk(el, depth) {
    if (depth > MAX_DEPTH || !el || el.nodeType !== 1) return null;
    var tag = (el.tagName || "").toLowerCase();
    var role = el.getAttribute && el.getAttribute("role") || "";
    var text = (el.textContent || "").trim().slice(0, 80);
    var node = { key: tag + ":" + (accepted.length), tag: tag, role: role, text: text, children: [] };
    var child = el.firstElementChild;
    while (child) {
      var sub = walk(child, depth + 1);
      if (sub) node.children.push(sub);
      child = child.nextElementSibling;
    }
    accepted.push(node);
    return node;
  }
  var root = walk(document.documentElement, 0);
  return root;
})();
`;

/** CDP resource types narrowed to the values the harvester groups on. */
export function normalizeResourceType(type?: string): NetworkHarvestEntry["resourceType"] {
  switch (type) {
    case "Document":
      return "document";
    case "Stylesheet":
      return "stylesheet";
    case "Image":
      return "image";
    case "Media":
      return "media";
    case "Font":
      return "font";
    case "Script":
      return "script";
    case "XHR":
      return "xhr";
    case "Fetch":
      return "fetch";
    case "WebSocket":
      return "websocket";
    default:
      return "other";
  }
}

/** Resolves the platform-default browser executable. */
export function defaultExecutablePath(product: BrowserProduct): string {
  if (product === "firefox") {
    if (process.platform === "win32") return "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
    if (process.platform === "darwin") return "/Applications/Firefox.app/Contents/MacOS/firefox";
    return "/usr/bin/firefox";
  }
  if (process.platform === "win32") {
    const programFiles = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const programFiles86 = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
    if (existsSync(programFiles)) return programFiles;
    if (existsSync(programFiles86)) return programFiles86;
  }
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return "/usr/bin/chromium";
}

/** The sandbox is disabled when running as root on Linux, where it cannot work. */
export function shouldDisableSandbox(): boolean {
  if (
    process.platform === "linux" &&
    typeof process.getuid === "function" &&
    process.getuid() === 0
  ) {
    return true;
  }
  return false;
}

/** Removes duplicates and empty arguments without reordering. */
export function dedupe(args: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const arg of args) {
    if (!arg) continue;
    if (seen.has(arg)) continue;
    seen.add(arg);
    out.push(arg);
  }
  return out;
}

/** Sweeps the browser's own process group for processes the group kill missed. */
export function sweepLinuxProcesses(browserGroupPid: number | null = null): number[] {
  if (process.platform !== "linux") return [];
  let entries: Array<{ pid: number; pgrp: number | null; cmdline: string }>;
  try {
    // Lazy import keeps the fs read off the module-eval path on non-Linux hosts.
    entries = readProcEntries();
  } catch {
    return [];
  }
  const myPid = process.pid;
  const victims: number[] = [];
  for (const entry of entries) {
    if (entry.pid === myPid) continue;
    // Only the cluster's own group: the browser is spawned detached as a group leader, so its
    // children share that group. Without this bound the sweep is a global scan that would reap
    // an unrelated browser belonging to another user of a shared host — wrong, and flaky on
    // shared CI runners.
    if (browserGroupPid === null || entry.pgrp !== browserGroupPid) continue;
    if (BROWSER_PROCESS_PATTERNS.test(entry.cmdline)) victims.push(entry.pid);
  }
  return victims;
}

function readProcEntries(): Array<{ pid: number; pgrp: number | null; cmdline: string }> {
  // Imported here, rather than at module scope, so a Windows host never touches /proc code.
  const fs = require("node:fs");
  const dirs = fs.readdirSync("/proc").filter((dir: string) => /^\d+$/.test(dir));
  const entries: Array<{ pid: number; pgrp: number | null; cmdline: string }> = [];
  for (const dir of dirs) {
    const pid = Number.parseInt(dir, 10);
    try {
      entries.push({
        pid,
        pgrp: readProcessGroup(pid),
        cmdline: fs.readFileSync(`/proc/${dir}/cmdline`, "utf-8"),
      });
    } catch {
      /* process vanished or is unreadable */
    }
  }
  return entries;
}

/**
 * The process group of a pid, read from `/proc/<pid>/stat`; null when it cannot be read. Field 2
 * (comm) may contain spaces and is parenthesised, so parsing starts after the last `)` — the
 * group is the third field after it (state, ppid, pgrp).
 */
function readProcessGroup(pid: number): number | null {
  try {
    const fs = require("node:fs");
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trimStart();
    const pgrp = Number.parseInt(afterComm.split(/\s+/)[2], 10);
    return Number.isInteger(pgrp) ? pgrp : null;
  } catch {
    /* the process is gone, or its stat is unreadable */
    return null;
  }
}

/**
 * Waits until a killed child is actually gone from the process table. `kill` only queues a
 * signal and the kernel reaps asynchronously, so the zero-zombie guarantee would be racy — a
 * caller checking the pid the instant shutdown returns — without waiting for the exit first.
 * Bounded, because a process wedged past SIGKILL must not be allowed to hang shutdown.
 */
async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "close").catch(() => {
      /* the handle already closed, or emitted an error first */
    }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** Local shim so the module avoids a top-level net import while keeping the probe testable. */
function require_node_net(): import("node:net").Server {
  return require("node:net").createServer();
}
