/**
 * Auto-rotating Inference Proxy Pool for LLM & API calls.
 *
 * Supports HTTP, HTTPS, SOCKS4 and SOCKS5 proxies, health tracking and rotation.
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
  strategy?: RotationStrategy;
  rateLimitCooldownMs?: number;
  errorCooldownMs?: number;
  maxConsecutiveFailures?: number;
  deadCooldownMs?: number;
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

function defaultProxyPort(protocol: ProxyProtocol): number {
  if (protocol === "http") return 8080;
  if (protocol === "https") return 8443;
  return 1080;
}

/**
 * Extract the port spelling from the original authority before WHATWG URL normalization.
 * URL.port intentionally becomes empty for explicit standard ports (HTTP 80 / HTTPS 443), so
 * treating an empty normalized port as "not supplied" changes a caller's destination.
 */
function extractExplicitPort(input: string): number | undefined {
  const scheme = /^[a-zA-Z0-9+.-]+:\/\//.exec(input);
  const afterScheme = scheme ? input.slice(scheme[0].length) : input;
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? "";
  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;

  let portText: string | undefined;
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close >= 0 && hostPort[close + 1] === ":") {
      portText = hostPort.slice(close + 2);
    }
  } else {
    const match = /:(\d+)$/.exec(hostPort);
    portText = match?.[1];
  }

  if (portText === undefined) return undefined;
  const port = Number.parseInt(portText, 10);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid proxy port '${portText}'`);
  }
  return port;
}

function canonicalHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Parse a proxy URL while preserving explicitly supplied standard ports. */
export function parseProxyUrl(rawUrl: string): {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  auth?: ProxyAuth;
  canonicalUrl: string;
} {
  let input = rawUrl.trim();
  if (!input) throw new Error("Proxy URL cannot be empty");

  if (!/^[a-zA-Z0-9+.-]+:\/\//.test(input)) {
    input = `http://${input}`;
  }

  const explicitPort = extractExplicitPort(input);
  const parsed = new URL(input);
  const rawProto = parsed.protocol.replace(/:$/, "").toLowerCase();

  let protocol: ProxyProtocol;
  if (rawProto === "http") protocol = "http";
  else if (rawProto === "https") protocol = "https";
  else if (rawProto === "socks4") protocol = "socks4";
  else if (rawProto === "socks5" || rawProto === "socks") protocol = "socks5";
  else throw new Error(`Unsupported proxy protocol: ${rawProto}`);

  const host = parsed.hostname;
  if (!host) throw new Error(`Invalid proxy host in URL: ${rawUrl}`);

  const normalizedPort = parsed.port ? Number.parseInt(parsed.port, 10) : undefined;
  const port = explicitPort ?? normalizedPort ?? defaultProxyPort(protocol);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid proxy port in URL: ${rawUrl}`);
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
  const canonicalUrl = `${protocol}://${authString}${canonicalHost(host)}:${port}`;

  return { protocol, host, port, auth, canonicalUrl };
}

export class InferenceProxyPool {
  private proxies = new Map<string, ProxyEntry>();
  /** Administrative eligibility is deliberately separate from transport health. */
  private administrativelyDisabled = new Set<string>();
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

  public addProxy(input: string | ProxyInput): ProxyEntry {
    const rawUrl = typeof input === "string" ? input : input.url;
    const weight = typeof input === "object" && input.weight && input.weight > 0 ? input.weight : 1;
    const tags = typeof input === "object" && Array.isArray(input.tags) ? input.tags : [];

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

  public addProxies(inputs: (string | ProxyInput)[]): ProxyEntry[] {
    const results: ProxyEntry[] = [];
    for (const input of inputs) {
      try {
        results.push(this.addProxy(input));
      } catch {
        // Import helpers intentionally skip malformed entries.
      }
    }
    return results;
  }

  public removeProxy(idOrUrl: string): boolean {
    if (this.proxies.has(idOrUrl)) {
      const entry = this.proxies.get(idOrUrl)!;
      this.administrativelyDisabled.delete(entry.id);
      return this.proxies.delete(idOrUrl);
    }
    for (const [url, entry] of this.proxies.entries()) {
      if (entry.id === idOrUrl) {
        this.administrativelyDisabled.delete(entry.id);
        return this.proxies.delete(url);
      }
    }
    return false;
  }

  public getProxyEntry(idOrUrl: string): ProxyEntry | undefined {
    if (this.proxies.has(idOrUrl)) return this.proxies.get(idOrUrl);
    for (const entry of this.proxies.values()) {
      if (entry.id === idOrUrl) return entry;
    }
    return undefined;
  }

  private isDisabled(entry: ProxyEntry): boolean {
    return this.administrativelyDisabled.has(entry.id) || entry.status === "disabled";
  }

  public getNextProxy(criteria?: ProxySelectionCriteria): ProxyEntry | undefined {
    this.refreshCooldowns();

    const candidates = Array.from(this.proxies.values()).filter((entry) => {
      if (this.isDisabled(entry) || entry.status !== "healthy") return false;
      if (criteria?.protocol && entry.protocol !== criteria.protocol) return false;
      if (criteria?.maxLatencyMs && entry.latencyMs > 0 && entry.latencyMs > criteria.maxLatencyMs) return false;
      if (criteria?.tags?.length && !criteria.tags.every((tag) => entry.tags.includes(tag))) return false;
      return true;
    });

    if (candidates.length === 0) return undefined;
    const firstCandidate = candidates[0]!;
    let selected = firstCandidate;

    if (this.strategy === "least-latency") {
      const untested = candidates.filter((candidate) => candidate.latencyMs === 0);
      if (untested.length > 0) {
        selected = untested[Math.floor(Math.random() * untested.length)] ?? firstCandidate;
      } else {
        candidates.sort((a, b) => a.latencyMs - b.latencyMs);
        selected = candidates[0] ?? firstCandidate;
      }
    } else if (this.strategy === "weighted") {
      const totalWeight = candidates.reduce((sum, candidate) => sum + Math.max(1, candidate.weight), 0);
      let random = Math.random() * totalWeight;
      for (const candidate of candidates) {
        random -= Math.max(1, candidate.weight);
        if (random <= 0) {
          selected = candidate;
          break;
        }
      }
    } else {
      this.roundRobinIndex %= candidates.length;
      selected = candidates[this.roundRobinIndex] ?? firstCandidate;
      this.roundRobinIndex = (this.roundRobinIndex + 1) % candidates.length;
    }

    selected.lastUsedAt = Date.now();
    return selected;
  }

  public recordSuccess(idOrUrl: string, latencyMs: number): void {
    const entry = this.getProxyEntry(idOrUrl);
    if (!entry) return;

    entry.successCount += 1;
    entry.consecutiveFailures = 0;
    entry.lastUsedAt = Date.now();

    if (!this.isDisabled(entry)) {
      entry.status = "healthy";
      entry.cooldownUntil = 0;
    }

    if (latencyMs > 0) {
      entry.latencyMs = entry.latencyMs === 0
        ? latencyMs
        : Math.round(this.emaAlpha * latencyMs + (1 - this.emaAlpha) * entry.latencyMs);
    }
  }

  public recordFailure(
    idOrUrl: string,
    options: { isRateLimit?: boolean; isAuthFailure?: boolean; error?: string } = {},
  ): void {
    const entry = this.getProxyEntry(idOrUrl);
    if (!entry) return;

    entry.failureCount += 1;
    entry.consecutiveFailures += 1;
    entry.lastUsedAt = Date.now();

    // A late transport callback may update counters, but must never reverse an operator's disable.
    if (this.isDisabled(entry)) return;

    if (options.isAuthFailure) {
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

  /** Explicit status changes are administrative and therefore may clear a manual disable. */
  public setStatus(idOrUrl: string, status: ProxyStatus): boolean {
    const entry = this.getProxyEntry(idOrUrl);
    if (!entry) return false;

    if (status === "disabled") {
      this.administrativelyDisabled.add(entry.id);
      entry.status = "disabled";
      return true;
    }

    this.administrativelyDisabled.delete(entry.id);
    entry.status = status;
    if (status === "healthy") {
      entry.cooldownUntil = 0;
      entry.consecutiveFailures = 0;
    }
    return true;
  }

  /**
   * Cooldown expiry controls retry eligibility only. Failure history survives until a demonstrated
   * success or an explicit reset, so repeated failure/cooldown cycles can reach the dead threshold.
   */
  public refreshCooldowns(): void {
    const now = Date.now();
    for (const entry of this.proxies.values()) {
      if (this.isDisabled(entry)) continue;
      if (
        (entry.status === "cooldown" || entry.status === "dead") &&
        entry.cooldownUntil > 0 &&
        now >= entry.cooldownUntil
      ) {
        entry.status = "healthy";
        entry.cooldownUntil = 0;
      }
    }
  }

  public resetAll(): void {
    for (const entry of this.proxies.values()) {
      if (this.isDisabled(entry)) continue;
      entry.status = "healthy";
      entry.cooldownUntil = 0;
      entry.consecutiveFailures = 0;
    }
  }

  public getStats(): ProxyPoolStats {
    this.refreshCooldowns();
    let healthy = 0;
    let cooldown = 0;
    let dead = 0;
    let disabled = 0;
    let totalLatency = 0;
    let measuredCount = 0;

    for (const entry of this.proxies.values()) {
      if (this.isDisabled(entry)) disabled += 1;
      else if (entry.status === "healthy") healthy += 1;
      else if (entry.status === "cooldown") cooldown += 1;
      else if (entry.status === "dead") dead += 1;

      if (entry.latencyMs > 0) {
        totalLatency += entry.latencyMs;
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

  public exportEntries(): ProxyEntry[] {
    return Array.from(this.proxies.values()).map((entry) => ({
      ...entry,
      status: this.isDisabled(entry) ? "disabled" : entry.status,
      auth: entry.auth ? { ...entry.auth } : undefined,
      tags: [...entry.tags],
    }));
  }

  public importEntries(entries: ProxyEntry[]): void {
    for (const source of entries) {
      if (!source?.url) continue;
      const entry: ProxyEntry = {
        ...source,
        auth: source.auth ? { ...source.auth } : undefined,
        tags: Array.isArray(source.tags) ? [...source.tags] : [],
      };
      this.proxies.set(entry.url, entry);
      if (entry.status === "disabled") this.administrativelyDisabled.add(entry.id);
      else this.administrativelyDisabled.delete(entry.id);
    }
  }

  public clear(): void {
    this.proxies.clear();
    this.administrativelyDisabled.clear();
    this.roundRobinIndex = 0;
  }
}
