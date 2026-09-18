/**
 * The wire contract between the steerable browser cluster (server) and the cockpit browser
 * widgets (web).
 *
 * Everything here is pure data with no runtime dependency on either side: the server serializes
 * these from live CDP traffic, and the web feature renders them. Keeping the contract in core —
 * rather than letting the server and web each define a private copy — is what keeps a frame
 * emitted by the cluster readable by the viewport widget without a shared codegen step, and it
 * keeps the payload shapes stable across the two packages' independent release cadences.
 *
 * Provenance: the shapes are the intersection of what the donors actually surface to their UIs —
 * the session viewer's frame stream and network/DOM instrumentation records — normalized to the
 * names this harness uses elsewhere (`sessionId`, `targetId`, `timestamp` as ISO strings).
 */

/** Kind of cluster event; the widget family routes on this discriminator. */
export enum CockpitBrowserEventKind {
  SessionStarted = "session.started",
  SessionEnded = "session.ended",
  Navigation = "session.navigation",
  Frame = "viewport.frame",
  DomSnapshot = "dom.snapshot",
  NetworkEntry = "network.entry",
  ConsoleMessage = "page.console",
  Error = "cluster.error",
  Metrics = "cluster.metrics",
}

/** Lifecycle state of one isolated session, mirrored from the cluster's own bookkeeping. */
export enum BrowserSessionState {
  Pending = "pending",
  Launching = "launching",
  Live = "live",
  Reconnecting = "reconnecting",
  Ending = "ending",
  Ended = "ended",
  Failed = "failed",
}

/** A decoded CDP target: a page, an iframe, a service worker or another target type. */
export interface TargetDescriptor {
  targetId: string;
  type: "page" | "iframe" | "service_worker" | "worker" | "other";
  url: string;
  title: string;
}

/** Viewport geometry as the cluster reports it for the active target. */
export interface ViewportInfo {
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
}

/** One compressed frame of a live viewport, ready to paint onto a canvas. */
export interface ViewportFrame {
  /** Session the frame belongs to. */
  sessionId: string;
  /** Target (page) within the session. */
  targetId: string;
  /** Frame sequence number; gaps are the dropped-frame signal the widget displays. */
  sequence: number;
  width: number;
  height: number;
  /** JPEG/PNG data URL, or a raw base64 body when `encoding` is `binary`. */
  data: string;
  encoding: "data-url" | "base64";
  /** Wall-clock capture time, ISO 8601. */
  timestamp: string;
}

/** A node of the accessibility/DOM tree the inspector widget renders. */
export interface DomTreeNode {
  /** Stable key within one snapshot; the widget uses it for React reconciliation. */
  key: string;
  tag: string;
  role: string;
  text: string;
  /** Index the agent would reference this element by, when the cluster assigns one. */
  index?: number;
  /** Geometric box in CSS pixels, used to draw the hover highlight. */
  rect?: { x: number; y: number; width: number; height: number };
  children: DomTreeNode[];
}

/** A full DOM tree snapshot plus the viewport state it was captured under. */
export interface DomSnapshot {
  sessionId: string;
  targetId: string;
  root: DomTreeNode;
  viewport: ViewportInfo;
  scrollX: number;
  scrollY: number;
  timestamp: string;
}

/** Resource type as CDP reports it, narrowed to the values the harvester card groups on. */
export type NetworkResourceType =
  | "document"
  | "stylesheet"
  | "image"
  | "media"
  | "font"
  | "script"
  | "xhr"
  | "fetch"
  | "websocket"
  | "other";

/** One harvested network exchange, as the cockpit's harvester card lists it. */
export interface NetworkHarvestEntry {
  sessionId: string;
  targetId: string;
  /** CDP requestId; correlates request, response and failure phases. */
  requestId: string;
  method: string;
  url: string;
  resourceType: NetworkResourceType;
  /** HTTP status; absent while the request is still in flight or failed before a response. */
  status?: number;
  mimeType?: string;
  /** Bytes on the wire as CDP last reported (encoded length). */
  encodedDataLength?: number;
  /** True when the exchange completed with a non-2xx/3xx status or failed outright. */
  failed?: boolean;
  /** Short reason when `failed`, e.g. the CDP error text. */
  failureText?: string;
  timestamp: string;
  /** Duration from request to finish, in milliseconds, once known. */
  durationMs?: number;
}

/** A page console message captured for the session's telemetry trail. */
export interface ConsoleMessage {
  sessionId: string;
  targetId: string;
  level: "log" | "info" | "warning" | "error" | "debug";
  text: string;
  url?: string;
  lineNumber?: number;
  timestamp: string;
}

/** Cluster-wide rolling metrics the cockpit renders as KPI tiles. */
export interface BrowserClusterMetrics {
  /** Live sessions, by state. */
  sessions: Partial<Record<BrowserSessionState, number>>;
  /** Cold launches finished within the 650ms target / total cold launches. */
  coldLaunches: { withinTarget: number; total: number };
  /** Pooled CDP sessions currently checked out vs. configured capacity. */
  pool: { active: number; idle: number; capacity: number };
  /** Aggregate DOM-query latency in ms: p50 and p95 over the recent window. */
  domQueryLatencyMs: { p50: number; p95: number };
  /** Frames delivered vs. dropped since the cockpit connected. */
  viewportFrames: { delivered: number; dropped: number };
  /** Browser processes the cluster parented but that outlived their session (want 0). */
  zombieProcesses: number;
  timestamp: string;
}

/** Discriminated union every cluster event carries over the cockpit channel. */
export type CockpitBrowserEvent =
  | {
      kind: typeof CockpitBrowserEventKind.SessionStarted;
      sessionId: string;
      state: BrowserSessionState;
      targets: TargetDescriptor[];
      viewport: ViewportInfo;
      timestamp: string;
    }
  | {
      kind: typeof CockpitBrowserEventKind.SessionEnded;
      sessionId: string;
      reason: string;
      timestamp: string;
    }
  | {
      kind: typeof CockpitBrowserEventKind.Navigation;
      sessionId: string;
      targetId: string;
      url: string;
      timestamp: string;
    }
  | { kind: typeof CockpitBrowserEventKind.Frame; frame: ViewportFrame }
  | { kind: typeof CockpitBrowserEventKind.DomSnapshot; snapshot: DomSnapshot }
  | { kind: typeof CockpitBrowserEventKind.NetworkEntry; entry: NetworkHarvestEntry }
  | { kind: typeof CockpitBrowserEventKind.ConsoleMessage; message: ConsoleMessage }
  | {
      kind: typeof CockpitBrowserEventKind.Error;
      sessionId?: string;
      code: string;
      message: string;
      retryable: boolean;
      timestamp: string;
    }
  | { kind: typeof CockpitBrowserEventKind.Metrics; metrics: BrowserClusterMetrics };
