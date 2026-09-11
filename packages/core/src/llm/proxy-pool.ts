/**
 * Auto-rotating Inference Proxy Pool for LLM & API calls.
 *
 * Synthesized from OpenCode-Unlimited-ProxyPool (Project 105) and one-api (Project 099).
 *
 * Features:
 * - Supports HTTP, HTTPS, SOCKS4, and SOCKS5 proxy endpoints.
 * - Dynamic rotation strategies: Round-Robin, Least-Latency (EMA), and Weighted.
 * - Exponential moving average (EMA) latency tracking for each endpoint.
 * - Health tracking: Consecutive failure tracking, transient cooldowns (429 rate limits),
 *   and dead-host eviction.
 * - Tag-based routing (e.g. "residential", "fast", "us", "eu").
 * - Import/export of proxy lists with status persistence.
 * - Zero external dependencies; pure TypeScript.
 */

export type ProxyProtocol = "http" | "https" | "socks4" | "socks5";
export type ProxyStatus = "healthy" | "cooldown" | "dead" | "disabled";
export type RotationStrategy = "round-robin" | "least-latency" | "weighted";

export interface ProxyAuth {
  username: string;
  password?: string;
}

export interface ProxyEntry {
  id: string;
  url: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  auth?: ProxyAuth;
  weight: number;
  status: ProxyStatus;
  latencyMs: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastUsedAt: number;
  lastTestedAt: number;
  tags: string[];
}

export interface ProxyInput {
  url: string;
  weight?: number;
  tags?: string[];
}

export interface ProxyPoolOptions {
  /** Strategy for selecting proxies: 'round-robin', 'least-latency', or 'weighted'. Default: 'least-latency'. */
  strategy?: RotationStrategy;
  /** Cooldown in milliseconds for rate-limited proxies (default 60,000ms = 1 min). */
  rateLimitCooldownMs?: number;
  /** Cooldown in milliseconds for transient connection errors (default 30,000ms = 30s). */
  errorCooldownMs?: number;
  /** Number of consecutive failures before a proxy is marked 'dead' (default 5). */
  maxConsecutiveFailures?: number;
  /** Cooldown in milliseconds for dead proxies before re-probing (default 600,000ms = 10 min). */
  deadCooldownMs?: number;
  /** Smoothing factor for exponential moving average latency (0.0 to 1.0, default 0.3). */
  emaAlpha?: number;
}

export interface ProxySelectionCriteria {
  tags?: string[];
  protocol?: ProxyProtocol;
  maxLatencyMs?: number;
}

export interface ProxyPoolStats {
  total: number;
  healthy: number;
  cooldown: number;
  dead: number;
  disabled: number;
  averageLatencyMs: number;
  strategy: RotationStrategy;
}

/**
 * Parses a proxy URL into its constituent components.
 * Supports:
 * - http://host:port
 * - http://user:pass@host:port
 * - socks5://host:port
 * - socks4://host:port
 * - host:port (defaults to http://)
 */
export function parseProxyUrl(rawUrl: string): {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  auth?: ProxyAuth;
  canonicalUrl: string;
} {
  let input = rawUrl.trim();
  if (!input) {
    throw new Error("Proxy URL cannot be empty");
  }

  // If no scheme, default to http://
  if (!/^[a-zA-Z0-9+-.]+:\/\//.test(input)) {
    input = `http://${input}`;
  }

  const parsed = new URL(input);
  const rawProto = parsed.protocol.replace(/:$/, "").toLowerCase();

  let protocol: ProxyProtocol;
  if (rawProto === "http") protocol = "http";
  else if (rawProto === "https") protocol = "https";
  else if (rawProto === "socks4") protocol = "socks4";
  else if (rawProto === "socks5" || rawProto === "socks") protocol = "socks5";
  else {
    throw new Error(`Unsupported proxy protocol: ${rawProto}`);
  }

  const host = parsed.hostname;
  if (!host) {
    throw new Error(`Invalid proxy host in URL: ${rawUrl}`);
  }

  let port = parsed.port ? parseInt(parsed.port, 10) : 0;
  if (!port || isNaN(port) || port < 1 || port > 65535) {
    if (protocol === "http") port = 8080;
    else if (protocol === "https") port = 8443;
    else if (protocol === "socks4" || protocol === "socks5") port = 1080;
    else port = 8080;
  }

  let auth: ProxyAuth | undefined;
  if (parsed.username) {
    auth = {
      username: decodeURIComponent(parsed.username),
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    };
  }

  const authString = auth
    ? `${encodeURIComponent(auth.username)}${auth.password ? `:${encodeURIComponent(auth.password)}` : ""}@`
    : "";
  const canonicalUrl = `${protocol}://${authString}${host}:${port}`;

  return {
    protocol,
    host,
    port,
    auth,
    canonicalUrl,
  };
}

export class InferenceProxyPool {
  private proxies = new Map<string, ProxyEntry>();
  private roundRobinIndex = 0;
  private readonly strategy: RotationStrategy;
  private readonly rateLimitCooldownMs: number;
  private readonly errorCooldownMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly deadCooldownMs: number;
  private readonly emaAlpha: number;

  constructor(options: ProxyPoolOptions = {}) {
    this.strategy = options.strategy ?? "least-latency";
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 60_000;
    this.errorCooldownMs = options.errorCooldownMs ?? 30_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    this.deadCooldownMs = options.deadCooldownMs ?? 600_000;
    this.emaAlpha = Math.max(0.01, Math.min(1.0, options.emaAlpha ?? 0.3));
  }

  /**
   * Adds a proxy to the pool. Overwrites or updates if the canonical URL already exists.
   */
  public addProxy(input: string | ProxyInput): ProxyEntry {
    const rawUrl = typeof input === "string" ? input : input.url;
    const weight = (typeof input === "object" && input.weight && input.weight > 0) ? input.weight : 1;
    const tags = (typeof input === "object" && Array.isArray(input.tags)) ? input.tags : [];

    const parsed = parseProxyUrl(rawUrl);
    const existing = this.proxies.get(parsed.canonicalUrl);

    if (existing) {
      existing.weight = weight;
      existing.tags = Array.from(new Set([...existing.tags, ...tags]));
      return existing;
    }

    const entry: ProxyEntry = {
      id: `proxy_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      url: parsed.canonicalUrl,
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
      auth: parsed.auth,
      weight,
      status: "healthy",
      latencyMs: 0,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      lastUsedAt: 0,
      lastTestedAt: 0,
      tags,
    };

    this.proxies.set(parsed.canonicalUrl, entry);
    return entry;
  }

  /**
   * Adds multiple proxies from an array of strings or configurations.
   */
  public addProxies(inputs: (string | ProxyInput)[]): ProxyEntry[] {
    const results: ProxyEntry[] = [];
    for (const input of inputs) {
      try {
        results.push(this.addProxy(input));
      } catch {
        // Skip malformed entries
      }
    }
    return results;
  }

  /**
   * Removes a proxy by its canonical URL or entry ID.
   */
  public removeProxy(idOrUrl: string): boolean {
    if (this.proxies.has(idOrUrl)) {
      return this.proxies.delete(idOrUrl);
    }
    for (const [url, entry] of this.proxies.entries()) {
      if (entry.id === idOrUrl) {
        return this.proxies.delete(url);
      }
    }
    return false;
  }

  /**
   * Retrieves a proxy entry by canonical URL or ID.
   */
  public getProxyEntry(idOrUrl: string): ProxyEntry | undefined {
    if (this.proxies.has(idOrUrl)) {
      return this.proxies.get(idOrUrl);
    }
    for (const entry of this.proxies.values()) {
      if (entry.id === idOrUrl) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Selects the next available healthy proxy matching the given criteria.
   * If a proxy's cooldown has expired, its status is restored to 'healthy'.
   */
  public getNextProxy(criteria?: ProxySelectionCriteria): ProxyEntry | undefined {
    this.refreshCooldowns();

    const candidates = Array.from(this.proxies.values()).filter((p) => {
      if (p.status !== "healthy") return false;
      if (criteria?.protocol && p.protocol !== criteria.protocol) return false;
      if (criteria?.maxLatencyMs && p.latencyMs > 0 && p.latencyMs > criteria.maxLatencyMs) return false;
      if (criteria?.tags && criteria.tags.length > 0) {
        const hasAllTags = criteria.tags.every((t) => p.tags.includes(t));
        if (!hasAllTags) return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return undefined;
    }

    const firstCandidate = candidates[0];
    if (!firstCandidate) {
      return undefined;
    }

    let selected: ProxyEntry = firstCandidate;

    if (this.strategy === "least-latency") {
      // Find proxies with zero latency (untested) first, then sort by lowest EMA latency
      const untested = candidates.filter((c) => c.latencyMs === 0);
      if (untested.length > 0) {
        selected = untested[Math.floor(Math.random() * untested.length)] ?? firstCandidate;
      } else {
        candidates.sort((a, b) => a.latencyMs - b.latencyMs);
        selected = candidates[0] ?? firstCandidate;
      }
    } else if (this.strategy === "weighted") {
      const totalWeight = candidates.reduce((sum, c) => sum + Math.max(1, c.weight), 0);
      let rand = Math.random() * totalWeight;
      for (const c of candidates) {
        rand -= Math.max(1, c.weight);
        if (rand <= 0) {
          selected = c;
          break;
        }
      }
    } else {
      // Round-robin
      this.roundRobinIndex = this.roundRobinIndex % candidates.length;
      selected = candidates[this.roundRobinIndex] ?? firstCandidate;
      this.roundRobinIndex = (this.roundRobinIndex + 1) % candidates.length;
    }

    selected.lastUsedAt = Date.now();
    return selected;
  }

  /**
   * Records a successful request through a proxy, updating its latency and stats.
   */
  public recordSuccess(idOrUrl: string, latencyMs: number): void {
    const entry = this.getProxyEntry(idOrUrl);
    if (!entry) return;

    entry.successCount += 1;
    entry.consecutiveFailures = 0;
    entry.status = "healthy";
    entry.cooldownUntil = 0;
    entry.lastUsedAt = Date.now();

    if (latencyMs > 0) {
      if (entry.latencyMs === 0) {
        entry.latencyMs = latencyMs;
      } else {
        entry.latencyMs = Math.round(
          this.emaAlpha * latencyMs + (1 - this.emaAlpha) * entry.latencyMs
        );
      }
    }
  }

  /**
   * Records a request failure, initiating cooldown or marking as dead if threshold exceeded.
   */
  public recordFailure(
    idOrUrl: string,
    options: { isRateLimit?: boolean; isAuthFailure?: boolean; error?: string } = {}
  ): void {
    const entry = this.getProxyEntry(idOrUrl);
    if (!entry) return;

    entry.failureCount += 1;
    entry.consecutiveFailures += 1;
    entry.lastUsedAt = Date.now();

    if (options.isAuthFailure) {
      // Permanent failure for auth mismatch
      entry.status = "dead";
      entry.cooldownUntil = Date.now() + this.deadCooldownMs * 6;
      return;
    }

    if (options.isRateLimit) {
      entry.status = "cooldown";
      entry.cooldownUntil = Date.now() + this.rateLimitCooldownMs;
      return;
    }

    if (entry.consecutiveFailures >= this.maxConsecutiveFailures) {
      entry.status = "dead";
      entry.cooldownUntil = Date.now() + this.deadCooldownMs;
    } else {
      entry.status = "cooldown";
      entry.cooldownUntil = Date.now() + this.errorCooldownMs;
    }
  }

  /**
   * Sets the status of a proxy explicitly (e.g. to disable or enable).
   */
  public setStatus(idOrUrl: string, status: ProxyStatus): boolean {
    const entry = this.getProxyEntry(idOrUrl);
    if (!entry) return false;
    entry.status = status;
    if (status === "healthy") {
      entry.cooldownUntil = 0;
      entry.consecutiveFailures = 0;
    }
    return true;
  }

  /**
   * Checks expired cooldowns and restores proxies to 'healthy'.
   */
  public refreshCooldowns(): void {
    const now = Date.now();
    for (const entry of this.proxies.values()) {
      if (
        (entry.status === "cooldown" || entry.status === "dead") &&
        entry.cooldownUntil > 0 &&
        now >= entry.cooldownUntil
      ) {
        entry.status = "healthy";
        entry.cooldownUntil = 0;
        entry.consecutiveFailures = 0;
      }
    }
  }

  /**
   * Resets all proxies to healthy status and clears cooldowns.
   */
  public resetAll(): void {
    for (const entry of this.proxies.values()) {
      if (entry.status !== "disabled") {
        entry.status = "healthy";
        entry.cooldownUntil = 0;
        entry.consecutiveFailures = 0;
      }
    }
  }

  /**
   * Returns current pool aggregate statistics.
   */
  public getStats(): ProxyPoolStats {
    this.refreshCooldowns();
    let healthy = 0;
    let cooldown = 0;
    let dead = 0;
    let disabled = 0;
    let totalLatency = 0;
    let measuredCount = 0;

    for (const p of this.proxies.values()) {
      if (p.status === "healthy") healthy += 1;
      else if (p.status === "cooldown") cooldown += 1;
      else if (p.status === "dead") dead += 1;
      else if (p.status === "disabled") disabled += 1;

      if (p.latencyMs > 0) {
        totalLatency += p.latencyMs;
        measuredCount += 1;
      }
    }

    return {
      total: this.proxies.size,
      healthy,
      cooldown,
      dead,
      disabled,
      averageLatencyMs: measuredCount > 0 ? Math.round(totalLatency / measuredCount) : 0,
      strategy: this.strategy,
    };
  }

  /**
   * Exports all proxy entries for JSON serialization and persistence.
   */
  public exportEntries(): ProxyEntry[] {
    return Array.from(this.proxies.values()).map((p) => ({ ...p }));
  }

  /**
   * Imports proxy entries previously exported.
   */
  public importEntries(entries: ProxyEntry[]): void {
    for (const entry of entries) {
      if (entry && entry.url) {
        this.proxies.set(entry.url, { ...entry });
      }
    }
  }

  /**
   * Clears all proxies from the pool.
   */
  public clear(): void {
    this.proxies.clear();
    this.roundRobinIndex = 0;
  }
}
