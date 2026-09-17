import path from "node:path";
import ts from "typescript";

/** Watch programs with TypeScript's own source/config/dependency discovery. */
export function watchIfaces(projects, outPath, generate) {
  const programs = new Map();
  const watches = [];
  const timers = new Set();
  let generationTimer;
  let closed = false;
  const canonical = (file) => {
    const absolute = path.resolve(file);
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  };
  const output = canonical(outPath);
  const isOutput = (file) => canonical(file) === output;
  const report = (diagnostic) =>
    console.error(
      `gen-ifaces: error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(generationTimer);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const watch of watches) watch.close();
    programs.clear();
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  };
  const scheduleGeneration = () => {
    if (closed) return;
    clearTimeout(generationTimer);
    generationTimer = setTimeout(() => {
      // Wait for all projects' compiler updates, not just the first one's callback.
      if (timers.size || programs.size !== projects.length) {
        scheduleGeneration();
        return;
      }
      try {
        const diagnostics = [...programs.values()].flatMap((program) => [
          ...program.getConfigFileParsingDiagnostics(),
          ...program.getSyntacticDiagnostics(),
        ]);
        if (diagnostics.length) diagnostics.forEach(report);
        else generate(programs);
      } catch (error) {
        console.error(`gen-ifaces: error: ${error.message}`);
      }
    }, 100);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  try {
    for (const project of projects) {
      // API contract: TypeScript 5.9.3 lib/typescript.d.ts, WatchHost and Watch.
      // Official sample: https://github.com/microsoft/TypeScript/blob/v5.9.3/tests/cases/compiler/APISample_Watch.ts
      const host = ts.createWatchCompilerHost(
        project,
        { noEmit: true },
        ts.sys,
        ts.createSemanticDiagnosticsBuilderProgram,
        report,
        () => {},
      );
      // Do not call the default callback: it emits and runs full type diagnostics.
      // Reflection preserves the one-shot projector's semantic validation policy.
      host.afterProgramCreate = (builder) => {
        programs.set(project, builder.getProgram());
        scheduleGeneration();
      };
      host.onUnRecoverableConfigFileDiagnostic = (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      };
      const watchFile = host.watchFile;
      const watchDirectory = host.watchDirectory;
      host.watchFile = (file, callback, ...options) =>
        isOutput(file) ? { close() {} } : watchFile(file, callback, ...options);
      host.watchDirectory = (dir, callback, ...options) =>
        watchDirectory(
          dir,
          (file) => {
            if (!isOutput(file)) callback(file);
          },
          ...options,
        );
      // Track the compiler's debounce timers too: Watch.close() alone does not
      // cancel a pending program update in 5.9.3.
      host.setTimeout = (callback, ms, ...args) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!closed) callback(...args);
        }, ms);
        timers.add(timer);
        return timer;
      };
      host.clearTimeout = (timer) => {
        clearTimeout(timer);
        timers.delete(timer);
      };
      watches.push(ts.createWatchProgram(host));
    }
  } catch (error) {
    close();
    console.error(`gen-ifaces: error: ${error.message}`);
    process.exitCode = 1;
  }
}
