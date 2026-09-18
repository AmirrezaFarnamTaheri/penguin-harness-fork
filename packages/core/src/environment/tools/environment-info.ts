/**
 * environment_info — read-only host and path intelligence, a builtin tool implementation
 * (BuiltinTool): tells the model what machine it is running on and where a path string really
 * points, so it stops guessing about platforms, drive letters and line endings.
 *
 * Two questions, one call:
 * - no arguments: returns {@link describeEnvironment} — the OS and its shell layer (native
 *   Windows, MSYS2/Git-Bash, Cygwin, WSL and its distro), the shell, the working directory and
 *   its POSIX twin, the home directory, the OS's native line ending, and which path forms this
 *   machine resolves (the one that does NOT resolve — a POSIX path with no drive on a Windows
 *   kernel — is named explicitly, because that is the bug this tool exists for).
 * - `translate_path`: resolves that one path string to its absolute OS-native form and its
 *   POSIX twin, naming which form it was recognized as. A path that cannot be resolved
 *   (the `/tmp/x` case) ends the call as `failed` with the explanation, and the environment
 *   summary is still emitted first — the model gets the machine's facts either way.
 *
 * Everything the tool reports comes from process facts and pure string analysis: no file is
 * touched, no shell is spawned, nothing the model supplies can change what the machine is.
 * The tool is read-only and safe under any approval mode.
 *
 * Robustness properties:
 * - **Never guesses a location**: translate_path's failures are the point. A form that names
 *   no drive on a Windows kernel is refused with the forms that do work, instead of silently
 *   meaning the current drive's root.
 * - **Degrades to still-useful**: a `translate_path` that throws does not take the summary
 *   with it; the summary is yielded first, then the failure.
 * - A non-string/empty `translate_path` is an argument error restated from this tool's own
 *   schema, the same way every other tool explains a bad call.
 *
 * Division of responsibility with Environment (see environment.ts): non-streaming — yields one
 * final text delta; the translate_path failure is explanatory text finalized as `failed`;
 * nothing unexpected can throw out of this tool's generator except an Environment-caught
 * interruption. If interrupted, only reports `aborted`.
 * Docs: /docs/tools § "Environment".
 */
import { partialToolCallOutput } from "../../omnimessage/index.js";
import type { OmniMessage } from "../../omnimessage/index.js";
import type { ToolDefinitionConfig } from "../../interfaces/index.js";
import type { BuiltinTool, ToolExecutionContext, ToolResult } from "./types.js";
import { describeArgumentError } from "./tool-arguments.js";
import {
  PathTranslationError,
  describeEnvironment,
  detectHostEnvironment,
  translatePath,
} from "./host-environment.js";
import type { EnvironmentFacts, HostEnvironment } from "./host-environment.js";

/** Tool name constant (used only within this tool module, never exposed to Environment). */
export const ENVIRONMENT_INFO_NAME = "environment_info";

/** Fallback output budget when the definition carries no maxOutputLength (mirrors the default config entry). */
const DEFAULT_OUTPUT_BUDGET = 4000;

/**
 * The JSON schema for this tool's arguments, exported so a tool-config default can reference
 * one schema instead of duplicating it. `translate_path` is optional on purpose: the common
 * call asks only "what am I running on".
 */
export const ENVIRONMENT_INFO_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    translate_path: {
      type: "string",
      description:
        "Optional: a path in any form this machine uses (C:\\Users\\x, C:/Users/x, /c/Users/x, /mnt/c/Users/x, ~/x, or a relative path). Resolves it to the absolute OS-native path and its POSIX twin, and names the form it was recognized as.",
    },
  },
  required: [],
} as const;

/** Slices at a UTF-16 boundary that never splits a surrogate pair, so a trim cannot emit half a character. */
function safeSlice(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  // The last code unit kept may be a lead surrogate whose trail unit would be cut — drop it.
  if (last >= 0xd800 && last <= 0xdbff) return text.slice(0, limit - 1);
  return text.slice(0, limit);
}

/**
 * One line of the translate_path answer, or the failure explanation when the path does not resolve.
 * Path forms are recognized against `env` — the same facts the summary reports — so a tool posed
 * as another machine translates paths the way that machine would. Consulting the live process
 * instead would make the summary and the resolution disagree about which kernel is running.
 */
function describeTranslation(value: string, env: HostEnvironment): string {
  try {
    const resolved = translatePath(value, env);
    const where =
      resolved.form === "windows-native" || resolved.form === "unc"
        ? `native ${resolved.native}`
        : resolved.native;
    return (
      `translate_path "${value}" → ${where} (POSIX: ${resolved.posix}; form: ${resolved.form}` +
      `${resolved.drive !== null ? `, drive ${resolved.drive}` : ""})`
    );
  } catch (err) {
    const reason =
      err instanceof PathTranslationError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return `cannot resolve translate_path "${value}": ${reason}`;
  }
}

/**
 * environment_info builtin tool: reports the host environment, and optionally resolves one
 * path. `definition` is overridden by Environment at construction time with the same-named
 * entry from ToolConfig (description/arguments/permissions/limits); `facts` is injectable so
 * a caller (or a test) can pose as another machine — by default the machine this runs on.
 */
export function createEnvironmentInfoTool(
  definition: ToolDefinitionConfig,
  facts?: Partial<EnvironmentFacts>,
): BuiltinTool {
  // Detected once at construction: the machine does not change for the life of a tool
  // instance, and a per-call re-detection would only re-read /proc/version.
  const env = detectHostEnvironment(facts);
  return {
    name: definition.name,
    definition,
    async *execute(
      args: Record<string, unknown>,
      ctx: ToolExecutionContext,
    ): AsyncGenerator<OmniMessage, ToolResult | void> {
      const { toolCallId, signal } = ctx;
      const delta = (output: string): OmniMessage =>
        partialToolCallOutput({ eventType: "delta", output, toolCallId });

      const value = args["translate_path"];
      if (value !== undefined && value !== null) {
        if (typeof value !== "string") {
          yield delta(
            describeArgumentError(definition, args, {
              argument: "translate_path",
              kind: "invalid",
              detail: `expected a string (got ${JSON.stringify(value)})`,
            }),
          );
          return { stopReason: "fatal" };
        }
        if (value.trim() === "") {
          yield delta(
            describeArgumentError(definition, args, {
              argument: "translate_path",
              kind: "missing",
            }),
          );
          return { stopReason: "fatal" };
        }
      }
      if (signal?.aborted) return { stopReason: "aborted" };

      // The summary first, so a bad path never costs the model the machine's facts.
      const budget =
        definition.maxOutputLength !== undefined && definition.maxOutputLength > 0
          ? definition.maxOutputLength
          : DEFAULT_OUTPUT_BUDGET;
      const summary = describeEnvironment(env);
      if (typeof value === "string" && value.trim() !== "") {
        const line = describeTranslation(value.trim(), env);
        const failed = line.startsWith("cannot resolve");
        // Keep the summary whole and let the resolution line land after it; only a resolution
        // failure ends the call as failed, so the model knows it has to fix the path.
        yield delta(`${summary}\n\n${line}`);
        return failed ? { stopReason: "fatal" } : undefined;
      }
      // Only the summary is budget-trimmed, and never mid-surrogate-pair.
      yield delta(summary.length > budget ? safeSlice(summary, budget) : summary);
      return;
    },
  };
}
