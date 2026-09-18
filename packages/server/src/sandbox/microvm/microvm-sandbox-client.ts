/**
 * MicroVM sandbox client — the wire protocol for the hardware-isolated tier.
 *
 * Ported from the donor remote-sandbox SDK's client layer, which is the only
 * source among the ported archives that solved the problems a *remote* execution
 * backend poses: request timeouts that compose with caller cancellation, replay
 * after a rate-limit response, and an error taxonomy that lets a caller tell
 * "the sandbox does not exist" from "the control plane is busy" from "you sent a
 * bad argument". Those concerns transfer unchanged once the donor's brand names
 * and its SDK ergonomics are stripped.
 *
 * What is deliberately NOT ported:
 * - the donor's generated OpenAPI schema and its fetch middleware stack. This
 *   client speaks the same resource model (create / kill / info / timeout /
 *   network / pause / snapshot) over a plain `fetch`, because the harness has no
 *   codegen step and a generated client would be an unmaintained copy of a
 *   schema we do not own;
 * - the donor's envd gRPC and filesystem/process service clients. The isolated
 *   tier here runs a command and captures its output; a full remote-filesystem
 *   protocol is a separate surface this server does not expose.
 *
 * Security-relevant behaviour carried over verbatim:
 * - the retry layer replays ONLY a 429 carrying a decimal `Retry-After`, and only
 *   while the retry budget and the deadline hold. Any other 4xx/5xx is surfaced
 *   immediately, so a hostile control plane cannot stall a caller by feeding it
 *   retryable-looking headers;
 * - streaming bodies get exactly one attempt, because a replay would need to
 *   buffer a body this server has no business holding;
 * - the deadline applies even when per-request timeouts are disabled, so
 *   "no timeout" cannot mean "wait forever";
 * - a 404 on an info/kill call is surfaced as `MicrovmNotFoundError`, never as a
 *   generic error a caller might retry blindly.
 */
/** A line-oriented diagnostic sink, matching the rest of this server's runtime. */
export type MicrovmLogger = (line: string) => void;

/**
 * The connection constants, exactly as the donor defines them. The keepalive ping
 * interval is shorter than the 60s proxy idle timeout by design: a sandbox that
 * goes quiet must be pinged before an intermediary reaps the connection.
 */
export const REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_RETRIES = 3;
export const DEFAULT_SANDBOX_TIMEOUT_MS = 300_000;
export const KEEPALIVE_PING_INTERVAL_SEC = 50;
export const KEEPALIVE_PING_HEADER = "Keepalive-Ping-Interval";

/** A retry-after delta larger than this is refused rather than honoured. */
const MAX_RETRY_AFTER_SECONDS = 2_147_483;
/** Ceiling on retry waiting when a caller disables per-request timeouts. */
const MAX_RETRY_WAIT_WITHOUT_TIMEOUT_MS = 60_000;

/** Identifier of a provisioned microVM. */
export type MicrovmId = string;

/** Identifier of the template a microVM boots from. */
export type MicrovmTemplateId = string;

/** Lifecycle state of a microVM, as the control plane reports it. */
export type MicrovmStatus =
  "creating" | "running" | "paused" | "snapshotting" | "resumed" | "stopped" | "unknown";

/** How a paused microVM resumes. */
export type MicrovmResumeMode = "restore" | "reboot";

/** Options for a single request to the control plane. */
export interface MicrovmRequestOptions {
  /** Per-request timeout in ms; `0` disables it but not the retry deadline. */
  requestTimeoutMs?: number;
  /** Abort signal composed with the timeout. */
  signal?: AbortSignal;
  /** Extra headers, e.g. a request-scoped trace id. */
  headers?: Record<string, string>;
}

/** Connection configuration for the microVM control plane. */
export interface MicrovmConnectionConfig {
  /** Base URL of the control plane API. */
  apiUrl: string;
  /** Credential presented to the control plane. */
  apiKey: string;
  /** Template booted when a caller names none. */
  defaultTemplate: MicrovmTemplateId;
  /** Retries after a rate-limited request. */
  retries?: number;
  /** Default per-request timeout. */
  requestTimeoutMs?: number;
  /** Diagnostic sink; defaults to stderr so the client never requires one. */
  logger?: MicrovmLogger;
}

/** A provisioned microVM's identity and endpoints. */
export interface MicrovmInfo {
  readonly id: MicrovmId;
  readonly templateId: MicrovmTemplateId;
  readonly status: MicrovmStatus;
  /** Seconds until the control plane reaps an idle microVM. */
  readonly timeoutMs: number;
  /** The sandbox's own host, for direct envd connections. */
  readonly host?: string;
  /** Port the envd agent listens on inside the sandbox. */
  readonly envdPort: number;
  /** Port the MCP server listens on inside the sandbox. */
  readonly mcpPort: number;
}

/** Snapshot of a microVM's memory and disk at a point in time. */
export interface MicrovmSnapshot {
  readonly id: string;
  readonly sandboxId: MicrovmId;
  readonly createdAtMs: number;
}

/** Metrics the control plane reports for a running microVM. */
export interface MicrovmMetrics {
  readonly sandboxId: MicrovmId;
  readonly cpuCount: number;
  readonly memMiB: number;
  readonly diskMiB: number;
  readonly uptimeMs: number;
}

/** A command run inside a microVM. */
export interface MicrovmCommand {
  /** Command line to execute. */
  readonly cmd: string;
  /** Working directory inside the sandbox. */
  readonly cwd?: string;
  /** Environment for the command. */
  readonly env?: Record<string, string>;
  /** Wall-clock budget for the command in ms. */
  readonly timeoutMs?: number;
}

/** Result of a completed command. */
export interface MicrovmCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/**
 * Error taxonomy. Mirrors the donor's: a base class for control-plane failures that
 * carry the HTTP status, a timeout error distinct from other failures, a
 * not-found error that splits into "the file" vs "the sandbox", a rate-limit error,
 * and a service-busy error that is deliberately NOT a control-plane error because
 * it is raised for every 503 whatever the operation — so a caller catching the
 * base class does not accidentally swallow "try again in a moment".
 */
export class MicrovmError extends Error {
  constructor(
    message: string,
    /** HTTP status of the response that produced this error, when there was one. */
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "MicrovmError";
  }
}

/** A request exceeded its timeout, or the sandbox exceeded its lifetime budget. */
export class MicrovmTimeoutError extends MicrovmError {
  constructor(message: string) {
    super(message, 502);
    this.name = "MicrovmTimeoutError";
  }
}

/** An argument the caller supplied is invalid. */
export class MicrovmInvalidArgumentError extends MicrovmError {
  constructor(message: string) {
    super(message, 400);
    this.name = "MicrovmInvalidArgumentError";
  }
}

/** The control plane ran out of capacity. Retryable; nothing was changed. */
export class MicrovmServiceBusyError extends Error {
  readonly statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = "MicrovmServiceBusyError";
  }
}

/** A rate limit was hit. Carries the delay the control plane asked for. */
export class MicrovmRateLimitError extends MicrovmError {
  constructor(
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message, 429);
    this.name = "MicrovmRateLimitError";
  }
}

/** A resource was not found. Splits into file vs sandbox below. */
export class MicrovmNotFoundError extends MicrovmError {
  constructor(message: string) {
    super(message, 404);
    this.name = "MicrovmNotFoundError";
  }
}

/** A file or directory is absent inside the sandbox. */
export class MicrovmFileNotFoundError extends MicrovmNotFoundError {
  constructor(message: string) {
    super(message);
    this.name = "MicrovmFileNotFoundError";
  }
}

/** A sandbox is absent or no longer running. */
export class MicrovmSandboxNotFoundError extends MicrovmNotFoundError {
  constructor(message: string) {
    super(message);
    this.name = "MicrovmSandboxNotFoundError";
  }
}

/** Authentication with the control plane failed. Not a `MicrovmError`, per the donor. */
export class MicrovmAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrovmAuthenticationError";
  }
}

/** The template is incompatible with this client. */
export class MicrovmTemplateError extends MicrovmError {
  constructor(message: string) {
    super(message);
    this.name = "MicrovmTemplateError";
  }
}

/** Validate the retry budget: a non-negative integer, or the call is a bug. */
export function resolveRetries(retries: number): number {
  if (!Number.isInteger(retries) || retries < 0) {
    throw new MicrovmInvalidArgumentError(
      `Invalid retries=${retries}: expected a non-negative integer.`,
    );
  }
  return retries;
}

/**
 * Parse a `Retry-After` header. Only a decimal whole number of seconds is honoured;
 * an HTTP-date form and any malformed value return `undefined`, which means "do not
 * retry". A delta too large to honour safely is likewise refused.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const delay = Number(trimmed);
  return Number.isSafeInteger(delay) && delay <= MAX_RETRY_AFTER_SECONDS ? delay : undefined;
}

/** Sleep that rejects immediately when the signal is already aborted. */
function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Whether a body is a stream, and so replayable zero times. A replay would need to
 * buffer it, and this server does not hold request bodies in memory on principle.
 *
 * A `ReadableStream` is identified by its `getReader` — the brand every stream has and
 * no plain object or string does. The donor used a duck-typed `lock` check on the body
 * mixin; `getReader` is the narrower test, because a `ReadableStream` is exactly the
 * body form fetch accepts as a pipe rather than a buffer.
 */
function isStreamBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { getReader?: unknown }).getReader === "function"
  );
}

/** Compose the caller's signal with a timeout signal, or use the caller's alone. */
function buildRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  if (!timeoutMs) return signal ?? new AbortController().signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  // Composing without a controller: abort the composite when either source aborts.
  const composite = new AbortController();
  const forward = () => composite.abort(signal.reason ?? timeoutSignal.reason);
  if (signal.aborted) forward();
  else signal.addEventListener("abort", forward, { once: true });
  if (timeoutSignal.aborted) forward();
  else timeoutSignal.addEventListener("abort", forward, { once: true });
  return composite.signal;
}

/**
 * Wrap a `fetch` so a 429 with a valid `Retry-After` is replayed within the budget.
 * Everything else — including a 429 with a bad header — is returned as-is.
 */
export function withRateLimitRetry(
  fetchImpl: typeof fetch,
  retries: number,
  requestTimeoutMs: number,
  monotonic: () => number = () => performance.now(),
  sleep: (delayMs: number, signal: AbortSignal) => Promise<void> = wait,
): typeof fetch {
  return (async (input, init) => {
    if (retries === 0 || isStreamBody(init?.body)) return fetchImpl(input, init);

    const request =
      input instanceof Request && init === undefined ? input : new Request(input, init);
    const deadline = monotonic() + (requestTimeoutMs || MAX_RETRY_WAIT_WITHOUT_TIMEOUT_MS);

    for (let attempt = 0; ; attempt++) {
      // The last attempt sends the original: no point cloning a body we will not replay.
      const response = await fetchImpl(attempt === retries ? request : request.clone(), init);
      const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
      const delayMs = retryAfter === undefined ? undefined : retryAfter * 1000;

      if (
        response.status !== 429 ||
        delayMs === undefined ||
        attempt === retries ||
        monotonic() + delayMs >= deadline
      ) {
        return response;
      }

      // Release the response body before sleeping; a held connection during a long
      // retry wait is a socket leak against the control plane.
      await response.body?.cancel().catch(() => {});
      await sleep(delayMs, request.signal);
    }
  }) as typeof fetch;
}

/** Raise the typed error a response's status implies, or return the parsed body. */
async function readJsonOrThrow(response: Response, sandboxId?: MicrovmId): Promise<unknown> {
  if (response.status >= 200 && response.status < 300) {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  const body = await response.text().catch(() => "");
  const detail = body || response.statusText;
  switch (response.status) {
    case 400:
      throw new MicrovmInvalidArgumentError(detail);
    case 401:
    case 403:
      throw new MicrovmAuthenticationError(detail);
    case 404:
      throw sandboxId === undefined
        ? new MicrovmNotFoundError(detail)
        : new MicrovmSandboxNotFoundError(`microvm ${sandboxId} not found: ${detail}`);
    case 408:
    case 502:
    case 504:
      throw new MicrovmTimeoutError(detail);
    case 429: {
      const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
      throw new MicrovmRateLimitError(detail, retryAfter);
    }
    case 503:
      throw new MicrovmServiceBusyError(detail);
    default:
      throw new MicrovmError(detail, response.status);
  }
}

function infoFromJson(json: unknown): MicrovmInfo {
  const obj = json as Record<string, unknown>;
  const sandboxId = obj.sandboxId ?? obj.id;
  if (typeof sandboxId !== "string")
    throw new MicrovmError("control plane returned no sandbox id", 500);
  const status = obj.status;
  return {
    id: sandboxId,
    templateId: typeof obj.templateId === "string" ? obj.templateId : "base",
    status:
      status === "creating" ||
      status === "running" ||
      status === "paused" ||
      status === "snapshotting" ||
      status === "resumed" ||
      status === "stopped"
        ? status
        : "unknown",
    timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : DEFAULT_SANDBOX_TIMEOUT_MS,
    host: typeof obj.host === "string" ? obj.host : undefined,
    envdPort: typeof obj.envdPort === "number" ? obj.envdPort : 49983,
    mcpPort: typeof obj.mcpPort === "number" ? obj.mcpPort : 50005,
  };
}

/**
 * The client. One instance per control plane; the class is stateless beyond its
 * configuration so a long-lived server can hold a single client and reuse it.
 */
export class MicrovmSandboxClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly defaultTemplate: MicrovmTemplateId;
  private readonly retries: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: MicrovmLogger;
  private readonly fetchWithRetry: typeof fetch;

  constructor(
    config: MicrovmConnectionConfig,
    fetchImpl: typeof fetch = fetch,
    /**
     * Test seam: the sleep a retry waits for. Production leaves this out and gets the
     * real `wait`; a test passes a no-op so a `Retry-After` in minutes does not stall
     * the suite for minutes.
     */
    sleep: (delayMs: number, signal: AbortSignal) => Promise<void> = wait,
  ) {
    if (!config.apiUrl) throw new MicrovmInvalidArgumentError("apiUrl is required");
    if (!config.apiKey) throw new MicrovmInvalidArgumentError("apiKey is required");
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultTemplate = config.defaultTemplate;
    this.retries = resolveRetries(config.retries ?? DEFAULT_RETRIES);
    this.requestTimeoutMs = config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.logger = config.logger ?? ((line) => console.error(line));
    this.fetchWithRetry = withRateLimitRetry(
      fetchImpl,
      this.retries,
      this.requestTimeoutMs,
      undefined,
      sleep,
    );
  }

  private async request(
    path: string,
    method: string,
    body?: unknown,
    options?: MicrovmRequestOptions,
    /** Sandbox the call targets, so a 404 names it instead of the resource class. */
    sandboxId?: MicrovmId,
  ): Promise<unknown> {
    const timeoutMs = options?.requestTimeoutMs ?? this.requestTimeoutMs;
    const signal = buildRequestSignal(timeoutMs, options?.signal);
    const url = `${this.apiUrl}${path}`;
    this.logger(`microvm ${method} ${url}`);
    const response = await this.fetchWithRetry(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        [KEEPALIVE_PING_HEADER]: String(KEEPALIVE_PING_INTERVAL_SEC),
        ...options?.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    return readJsonOrThrow(response, sandboxId);
  }

  /** Provision a microVM from a template. */
  async create(
    params: {
      templateId?: MicrovmTemplateId;
      timeoutMs?: number;
      env?: Record<string, string>;
    } = {},
    options?: MicrovmRequestOptions,
  ): Promise<MicrovmInfo> {
    const json = await this.request(
      "/sandboxes",
      "POST",
      {
        templateId: params.templateId ?? this.defaultTemplate,
        timeoutMs: params.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
        env: params.env ?? {},
      },
      options,
    );
    return infoFromJson(json);
  }

  /** Fetch a microVM's info; a 404 becomes `MicrovmSandboxNotFoundError`. */
  async getInfo(sandboxId: MicrovmId, options?: MicrovmRequestOptions): Promise<MicrovmInfo> {
    const json = await this.request(
      `/sandboxes/${encodeURIComponent(sandboxId)}`,
      "GET",
      undefined,
      options,
      sandboxId,
    );
    return infoFromJson(json);
  }

  /** Whether the control plane still knows about a microVM. */
  async exists(sandboxId: MicrovmId, options?: MicrovmRequestOptions): Promise<boolean> {
    try {
      await this.getInfo(sandboxId, options);
      return true;
    } catch (error) {
      if (error instanceof MicrovmNotFoundError) return false;
      throw error;
    }
  }

  /** Adjust a microVM's idle-reap timeout. */
  async setTimeout(
    sandboxId: MicrovmId,
    timeoutMs: number,
    options?: MicrovmRequestOptions,
  ): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new MicrovmInvalidArgumentError(
        `timeoutMs must be a non-negative number, got ${timeoutMs}`,
      );
    }
    await this.request(
      `/sandboxes/${encodeURIComponent(sandboxId)}/timeout`,
      "POST",
      { timeoutMs },
      options,
    );
  }

  /** Update a running microVM's network egress policy. */
  async updateNetwork(
    sandboxId: MicrovmId,
    network: { egressAllowList?: readonly string[]; egressDenyList?: readonly string[] },
    options?: MicrovmRequestOptions,
  ): Promise<void> {
    await this.request(
      `/sandboxes/${encodeURIComponent(sandboxId)}/network`,
      "PATCH",
      {
        egressAllowList: network.egressAllowList ?? null,
        egressDenyList: network.egressDenyList ?? null,
      },
      options,
    );
  }

  /** Pause a microVM. A subsequent resume restores or reboots it. */
  async pause(sandboxId: MicrovmId, options?: MicrovmRequestOptions): Promise<void> {
    await this.request(
      `/sandboxes/${encodeURIComponent(sandboxId)}/pause`,
      "POST",
      undefined,
      options,
    );
  }

  /** Resume a paused microVM. `restore` keeps memory, `reboot` cold-starts. */
  async resume(
    sandboxId: MicrovmId,
    mode: MicrovmResumeMode = "restore",
    options?: MicrovmRequestOptions,
  ): Promise<MicrovmInfo> {
    if (mode !== "restore" && mode !== "reboot") {
      throw new MicrovmInvalidArgumentError(`onResume must be 'restore' or 'reboot', got ${mode}`);
    }
    const json = await this.request(
      `/sandboxes/${encodeURIComponent(sandboxId)}/resume`,
      "POST",
      { onResume: mode },
      options,
    );
    return infoFromJson(json);
  }

  /** Snapshot a microVM. */
  async createSnapshot(
    sandboxId: MicrovmId,
    options?: MicrovmRequestOptions,
  ): Promise<MicrovmSnapshot> {
    const json = (await this.request(
      `/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`,
      "POST",
      undefined,
      options,
    )) as { snapshot?: { id?: unknown }; id?: unknown; createdAtMs?: unknown } | null;
    if (!json) throw new MicrovmError("snapshot response was empty", 500);
    const id = json.snapshot?.id ?? json.id;
    if (typeof id !== "string") throw new MicrovmError("snapshot response has no id", 500);
    return {
      id,
      sandboxId,
      createdAtMs: typeof json.createdAtMs === "number" ? json.createdAtMs : Date.now(),
    };
  }

  /** Delete a snapshot. */
  async deleteSnapshot(
    sandboxId: MicrovmId,
    snapshotId: string,
    options?: MicrovmRequestOptions,
  ): Promise<void> {
    await this.request(
      `/sandboxes/${encodeURIComponent(sandboxId)}/snapshots/${encodeURIComponent(snapshotId)}`,
      "DELETE",
      undefined,
      options,
    );
  }

  /** Fork a microVM into a new one sharing the parent's state. */
  async forkSandbox(sandboxId: MicrovmId, options?: MicrovmRequestOptions): Promise<MicrovmInfo> {
    const json = await this.request(
      `/sandboxes/${encodeURIComponent(sandboxId)}/fork`,
      "POST",
      undefined,
      options,
    );
    return infoFromJson(json);
  }

  /** Read a microVM's resource metrics. */
  async getMetrics(sandboxId: MicrovmId, options?: MicrovmRequestOptions): Promise<MicrovmMetrics> {
    const json = (await this.request(
      `/sandboxes/${encodeURIComponent(sandboxId)}/metrics`,
      "GET",
      undefined,
      options,
    )) as Record<string, unknown> | null;
    if (!json) throw new MicrovmError("metrics response was empty", 500);
    return {
      sandboxId,
      cpuCount: typeof json.cpuCount === "number" ? json.cpuCount : 0,
      memMiB: typeof json.memMiB === "number" ? json.memMiB : 0,
      diskMiB: typeof json.diskMiB === "number" ? json.diskMiB : 0,
      uptimeMs: typeof json.uptimeMs === "number" ? json.uptimeMs : 0,
    };
  }

  /** Terminate a microVM. Idempotent: a 404 is not an error. */
  async kill(sandboxId: MicrovmId, options?: MicrovmRequestOptions): Promise<void> {
    try {
      await this.request(
        `/sandboxes/${encodeURIComponent(sandboxId)}`,
        "DELETE",
        undefined,
        options,
      );
    } catch (error) {
      if (error instanceof MicrovmNotFoundError) return;
      throw error;
    }
  }

  /**
   * Run a command inside a microVM and capture its output. This is the isolated
   * tier's execution primitive; the caller's escalation runtime holds the client and
   * calls this when a script needs a real process.
   */
  async runCommand(
    sandboxId: MicrovmId,
    command: MicrovmCommand,
    options?: MicrovmRequestOptions,
  ): Promise<MicrovmCommandResult> {
    if (!command.cmd) throw new MicrovmInvalidArgumentError("command.cmd is required");
    const startedAt = performance.now();
    const json = (await this.request(
      `/sandboxes/${encodeURIComponent(sandboxId)}/commands`,
      "POST",
      {
        cmd: command.cmd,
        cwd: command.cwd ?? "/home/user",
        env: command.env ?? {},
        timeoutMs: command.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      },
      options,
    )) as Record<string, unknown> | null;
    if (!json) throw new MicrovmError("command response was empty", 500);
    return {
      exitCode: typeof json.exitCode === "number" ? json.exitCode : 1,
      stdout: typeof json.stdout === "string" ? json.stdout : "",
      stderr: typeof json.stderr === "string" ? json.stderr : "",
      durationMs: performance.now() - startedAt,
      timedOut: json.timedOut === true,
    };
  }
}
