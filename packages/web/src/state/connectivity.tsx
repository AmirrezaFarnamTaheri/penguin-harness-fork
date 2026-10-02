/**
 * App-wide connectivity provider: one monitor, one health probe, one posture (F17.1/F17.2).
 *
 * Mounted by the app shell above the router, so every page and the banner read the same evidence
 * instead of each re-deriving "are we offline?" from whichever request failed for it first. The
 * probe is the cheapest endpoint that answers from the server process itself (`/api/health`); it is
 * deliberately not a page fetch, because a page can fail for unrelated reasons and a cached page
 * would answer with a false success.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createConnectivityMonitor,
  initialConnectivityState,
  type ConnectivityMonitor,
  type ConnectivityState,
} from "../lib/connectivity";

export interface ConnectivityContextValue {
  state: ConnectivityState;
  /** Manual retry; false when it was refused (nothing to retry, or rate-limited). */
  retry: () => boolean;
}

const ConnectivityContext = createContext<ConnectivityContextValue>({
  state: initialConnectivityState(0),
  retry: () => false,
});

/**
 * The reachability probe. The monitor supplies the abort signal (per-attempt timeout) and treats a
 * rejection as a failure. Any HTTP answer counts as reachable — including a 401 from an expired
 * session, because that still proves the server is answering, and reporting "server unreachable"
 * for a login problem would be a false statement about the machine.
 */
async function probeHealth(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch("/api/health", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

/** Keeps the monitor's snapshot observable to React without copying state into React state. */
class ConnectivityStore {
  private state: ConnectivityState;
  private readonly listeners = new Set<() => void>();
  private readonly monitor: ConnectivityMonitor;

  constructor() {
    this.state = initialConnectivityState(
      typeof performance === "undefined" ? 0 : performance.now(),
    );
    this.monitor = createConnectivityMonitor({
      probe: probeHealth,
      onSnapshot: (state) => {
        this.state = state;
        for (const listener of this.listeners) listener();
      },
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ConnectivityState => this.state;

  start(): void {
    this.monitor.start();
  }

  stop(): void {
    this.monitor.stop();
  }

  retry(): boolean {
    return this.monitor.retry();
  }

  reportBrowserOnline(online: boolean): void {
    this.monitor.reportBrowserOnline(online);
  }
}

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<ConnectivityStore | null>(null);
  if (storeRef.current === null) storeRef.current = new ConnectivityStore();
  const store = storeRef.current;

  useEffect(() => {
    const onOnline = () => store.reportBrowserOnline(true);
    const onOffline = () => store.reportBrowserOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    // Seed from the browser's own answer before the first probe: a tab opened while the device is
    // offline must not spend attempts discovering that.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      store.reportBrowserOnline(false);
    }
    store.start();
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      // Cancels the in-flight probe and every timer, and ignores a late result: a probe that
      // settles after unmount must not touch state.
      store.stop();
    };
  }, [store]);

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const value = useMemo<ConnectivityContextValue>(
    () => ({ state, retry: () => store.retry() }),
    [store, state],
  );
  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): ConnectivityContextValue {
  return useContext(ConnectivityContext);
}
