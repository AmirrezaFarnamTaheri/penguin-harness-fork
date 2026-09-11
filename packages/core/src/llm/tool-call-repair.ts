/**
 * Tool-Call Repair and Context Truncation Pipeline.
 *
 * Harvested from Reasonix (Project 118: pi-reasonix-main) and OpenFang (Project 110).
 *
 * Provides runtime mitigation for common LLM failure modes:
 * 1. JSON truncation due to token limits mid-structure (unclosed braces/brackets).
 * 2. Leaked tool calls inside reasoning/`<think>` blocks or markdown code fences
 *    instead of formal structured tool_calls.
 * 3. Smart head+tail dual-end truncation for large outputs to preserve context and conclusion.
 * 4. Deep parameter schema flattening to prevent model argument dropping.
 */

export interface ScavengedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  source: "think_tag" | "code_fence" | "inline_pattern";
}

/**
 * Checks if a JSON string appears truncated (unbalanced open braces or brackets).
 */
export function isTruncatedJSON(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  try {
    JSON.parse(trimmed);
    return false; // Complete and valid
  } catch {
    let openBraces = 0;
    let closeBraces = 0;
    let openBrackets = 0;
    let closeBrackets = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === "{") openBraces++;
        else if (char === "}") closeBraces++;
        else if (char === "[") openBrackets++;
        else if (char === "]") closeBrackets++;
      }
    }

    return openBraces > closeBraces || openBrackets > closeBrackets;
  }
}

/**
 * Attempts to repair truncated JSON by balancing quotes, brackets, and braces.
 */
export function repairTruncatedJSON(text: string): { repaired: string; fixed: boolean } {
  if (!text || typeof text !== "string") {
    return { repaired: text, fixed: false };
  }

  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return { repaired: trimmed, fixed: false };
  } catch {
    // Proceed to repair
  }

  let openBraces = 0;
  let closeBraces = 0;
  let openBrackets = 0;
  let closeBrackets = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") openBraces++;
      else if (char === "}") closeBraces++;
      else if (char === "[") openBrackets++;
      else if (char === "]") closeBrackets++;
    }
  }

  let working = trimmed;

  // If left open inside a string, close the string
  if (inString) {
    working += '"';
  }

  // Strip dangling `"key":` or incomplete key-value pairs before closing structures
  working = working
    .replace(/,\s*"[^"]*"\s*:\s*$/, "")
    .replace(/\{\s*"[^"]*"\s*:\s*$/, "{")
    .replace(/,\s*$/, "");

  // Re-evaluate open/close braces and brackets after cleaning
  openBraces = 0;
  closeBraces = 0;
  openBrackets = 0;
  closeBrackets = 0;
  inString = false;
  escaped = false;

  for (let i = 0; i < working.length; i++) {
    const char = working[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") openBraces++;
      else if (char === "}") closeBraces++;
      else if (char === "[") openBrackets++;
      else if (char === "]") closeBrackets++;
    }
  }

  // Close brackets first (innermost array), then braces (outermost object)
  const missingBrackets = Math.max(0, openBrackets - closeBrackets);
  for (let i = 0; i < missingBrackets; i++) {
    working += "]";
  }

  const missingBraces = Math.max(0, openBraces - closeBraces);
  for (let i = 0; i < missingBraces; i++) {
    working += "}";
  }

  // Final check
  try {
    JSON.parse(working);
    return { repaired: working, fixed: true };
  } catch {
    return { repaired: text, fixed: false };
  }
}

/**
 * Scavenges tool calls that models leak into reasoning or markdown text instead of structured fields.
 */
export function scavengeToolCalls(content: string | null | undefined): ScavengedToolCall[] {
  if (!content || typeof content !== "string") return [];

  const found: ScavengedToolCall[] = [];
  const seenCalls = new Set<string>();

  function registerCall(name: string, rawArgs: unknown, source: ScavengedToolCall["source"]) {
    let args: Record<string, unknown> = {};
    if (typeof rawArgs === "string") {
      let str = rawArgs.trim();
      // If rawArgs is wrapped as a JSON string literal (e.g. "{\"key\": \"val\"}"), decode outer string first
      if (str.startsWith('"') && str.endsWith('"')) {
        try {
          const unescaped = JSON.parse(str);
          if (typeof unescaped === "string") {
            str = unescaped;
          } else if (typeof unescaped === "object" && unescaped !== null && !Array.isArray(unescaped)) {
            args = unescaped as Record<string, unknown>;
          }
        } catch {
          // Continue with str as-is
        }
      }

      if (Object.keys(args).length === 0) {
        const repaired = repairTruncatedJSON(str);
        try {
          args = JSON.parse(repaired.repaired);
        } catch {
          return;
        }
      }
    } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    } else {
      return;
    }

    const sig = `${name}::${JSON.stringify(args)}`;
    if (seenCalls.has(sig)) return;
    seenCalls.add(sig);

    found.push({
      id: `scavenged_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name,
      arguments: args,
      source,
    });
  }

  // 1. Tool calls in <think> blocks
  const thinkPattern = /<think>([\s\S]*?)<\/think>/g;
  let match: RegExpExecArray | null;
  while ((match = thinkPattern.exec(content)) !== null) {
    const thinkContent = match[1];
    if (thinkContent) {
      extractFromBlock(thinkContent, "think_tag", registerCall);
    }
  }

  // 2. Tool calls in markdown code fences
  const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  while ((match = fencePattern.exec(content)) !== null) {
    const fenceContent = match[1];
    if (fenceContent) {
      extractFromBlock(fenceContent, "code_fence", registerCall);
    }
  }

  // 3. Inline invocation patterns like `{"name": "...", "arguments": {...}}`
  extractFromBlock(content, "inline_pattern", registerCall);

  return found;
}

function extractFromBlock(
  text: string,
  source: ScavengedToolCall["source"],
  register: (name: string, args: unknown, source: ScavengedToolCall["source"]) => void
): void {
  // Pattern A: {"function": {"name": "...", "arguments": ...}}
  const fnObjPattern = /\{[\s\S]*?"function"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[\s\S]*?\}|"(?:[^"\\]|\\.)*")[\s\S]*?\}\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = fnObjPattern.exec(text)) !== null) {
    const fnName = m[1];
    const fnArgs = m[2];
    if (fnName && fnArgs) {
      register(fnName, fnArgs, source);
    }
  }

  // Pattern B: {"name": "...", "arguments": {...}}
  const directPattern = /\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[\s\S]*?\}|"(?:[^"\\]|\\.)*")[\s\S]*?\}/g;
  while ((m = directPattern.exec(text)) !== null) {
    const fnName = m[1];
    const fnArgs = m[2];
    if (fnName && fnArgs) {
      register(fnName, fnArgs, source);
    }
  }
}

/**
 * Dual-end truncation preserving BOTH the head (context/setup) and tail (conclusion/errors).
 *
 * Keeps ~60% head and ~40% tail of `maxChars`.
 */
export function truncateKeepEnds(
  content: string,
  maxChars = 12000,
  indicator?: string
): string {
  if (!content || content.length <= maxChars) {
    return content;
  }

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const head = content.slice(0, headChars);
  const tail = content.slice(content.length - tailChars);
  const omittedChars = content.length - maxChars;

  const marker = indicator ?? `\n\n... [Truncated ${omittedChars.toLocaleString()} characters preserving head & tail] ...\n\n`;
  return `${head}${marker}${tail}`;
}
