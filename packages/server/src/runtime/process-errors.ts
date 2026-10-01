import { incrementUnhandledRejectionCount, safeErrorSummary, serverLogger } from "./logger.js";
import type { StructuredLogger } from "./logger.js";

export interface ProcessErrorDependencies {
  record: (error: Error, code: "uncaught_exception" | "unhandled_rejection") => void;
  shutdown: (signal: "uncaughtException", exitCode: 1) => Promise<void>;
  logger?: Pick<StructuredLogger, "error">;
}

interface ProcessErrorTargetState {
  installed: boolean;
  dependencies: ProcessErrorDependencies | null;
}

interface ProcessErrorRegistry {
  targets: WeakMap<object, ProcessErrorTargetState>;
}

const STATE_KEY = Symbol.for("penguin.server.process-errors.v1");
const registry = globalThis as unknown as Record<PropertyKey, ProcessErrorRegistry | undefined>;
const shared = (registry[STATE_KEY] ??= { targets: new WeakMap() });

/**
 * Installs stable listeners once per process. Later server generations replace the active
 * dependencies while the listeners remain singular, so a hot-reloaded server cannot count
 * or persist one process failure twice.
 */
export function installProcessErrorHandlers(
  dependencies: ProcessErrorDependencies,
  target: NodeJS.Process = process,
): void {
  let state = shared.targets.get(target);
  if (state === undefined) {
    state = { installed: false, dependencies: null };
    shared.targets.set(target, state);
  }
  state.dependencies = dependencies;
  if (state.installed) return;
  state.installed = true;

  target.on("unhandledRejection", (reason: unknown) => {
    const active = state.dependencies;
    if (active === null) return;
    const count = incrementUnhandledRejectionCount();
    const summary = safeErrorSummary(reason);
    const safeError = new Error(summary.message);
    safeError.name = summary.name;
    (active.logger ?? serverLogger).error("Unhandled promise rejection", {
      event: "unhandled_rejection",
      count,
      error: summary,
    });
    try {
      active.record(safeError, "unhandled_rejection");
    } catch {
      // The process observer is the last resort; a failing recorder must not re-enter it.
    }
  });

  target.on("uncaughtException", (reason: Error) => {
    const active = state.dependencies;
    if (active === null) return;
    const summary = safeErrorSummary(reason);
    const safeError = new Error(summary.message);
    safeError.name = summary.name;
    (active.logger ?? serverLogger).error("Uncaught exception", {
      event: "uncaught_exception",
      error: summary,
    });
    try {
      active.record(safeError, "uncaught_exception");
    } catch {
      // Shutdown still runs if error persistence is unavailable.
    }
    void Promise.resolve()
      .then(() => active.shutdown("uncaughtException", 1))
      .catch(() => process.exit(1));
  });
}
