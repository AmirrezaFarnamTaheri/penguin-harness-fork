/**
 * Tool-Call Repair and Context Truncation Pipeline.
 *
 * Provides conservative runtime mitigation for truncated JSON and tool calls leaked into text.
 */

export interface ScavengedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  source: "think_tag" | "code_fence" | "inline_pattern";
}

interface JsonScan {
  stack: Array<"{" | "[">;
  inString: boolean;
  escaped: boolean;
  invalid: boolean;
}

function scanJsonStructure(text: string): JsonScan {
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escaped = false;
  let invalid = false;

  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) {
        invalid = true;
        break;
      }
    }
  }

  return { stack, inString, escaped, invalid };
}

export function isTruncatedJSON(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    const scan = scanJsonStructure(trimmed);
    return !scan.invalid && (scan.inString || scan.stack.length > 0);
  }
}

export function repairTruncatedJSON(text: string): { repaired: string; fixed: boolean } {
  if (!text || typeof text !== "string") return { repaired: text, fixed: false };

  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return { repaired: trimmed, fixed: false };
  } catch {
    // Continue only with conservative structural repair.
  }

  let working = trimmed;
  let scan = scanJsonStructure(working);
  if (scan.invalid) return { repaired: text, fixed: false };

  if (scan.inString) {
    if (scan.escaped && working.endsWith("\\")) working = working.slice(0, -1);
    working += '"';
  }

  working = working
    .replace(/,\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, "")
    .replace(/\{\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, "{")
    .replace(/,\s*$/, "");

  scan = scanJsonStructure(working);
  if (scan.invalid || scan.inString) return { repaired: text, fixed: false };

  for (let i = scan.stack.length - 1; i >= 0; i--) {
    working += scan.stack[i] === "{" ? "}" : "]";
  }

  try {
    JSON.parse(working);
    return { repaired: working, fixed: true };
  } catch {
    return { repaired: text, fixed: false };
  }
}

export function scavengeToolCalls(content: string | null | undefined): ScavengedToolCall[] {
  if (!content || typeof content !== "string") return [];

  const found: ScavengedToolCall[] = [];
  /**
   * Signature -> source of its first occurrence. The extraction passes overlap: a think tag is
   * part of the content the inline pass re-scans, so the same call legitimately surfaces through
   * several sources. A repeat reaching a *different* source is that re-extraction and is
   * collapsed; a repeat reaching the *same* source is a genuinely distinct call (a retry after a
   * transient error, or two reasoning branches reading the same path) and must survive — silently
   * dropping it is the failure the sibling tool-call-ids.ts exists to prevent.
   */
  const firstSourceBySig = new Map<string, ScavengedToolCall["source"]>();

  function registerCall(name: string, rawArgs: unknown, source: ScavengedToolCall["source"]): void {
    let args: Record<string, unknown>;

    if (typeof rawArgs === "string") {
      const text = rawArgs.trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
        if (typeof parsed === "string") parsed = JSON.parse(parsed);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      args = parsed as Record<string, unknown>;
    } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    } else {
      return;
    }

    const sig = `${name}::${JSON.stringify(args)}`;
    const firstSource = firstSourceBySig.get(sig);
    if (firstSource !== undefined && firstSource !== source) return;
    if (firstSource === undefined) firstSourceBySig.set(sig, source);
    found.push({
      id: `scavenged_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name,
      arguments: args,
      source,
    });
  }

  const thinkPattern = /<think>([\s\S]*?)<\/think>/g;
  let match: RegExpExecArray | null;
  while ((match = thinkPattern.exec(content)) !== null) {
    if (match[1]) extractFromBlock(match[1], "think_tag", registerCall);
  }

  const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  while ((match = fencePattern.exec(content)) !== null) {
    if (match[1]) extractFromBlock(match[1], "code_fence", registerCall);
  }

  extractFromBlock(content, "inline_pattern", registerCall);
  return found;
}

function completeJsonObjects(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function extractFromBlock(
  text: string,
  source: ScavengedToolCall["source"],
  register: (name: string, args: unknown, source: ScavengedToolCall["source"]) => void,
): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const object = value as Record<string, unknown>;
    const skipKeys = new Set<string>();

    const fn = object.function;
    if (fn && typeof fn === "object" && !Array.isArray(fn)) {
      const functionObject = fn as Record<string, unknown>;
      if (typeof functionObject.name === "string" && functionObject.arguments !== undefined) {
        register(functionObject.name, functionObject.arguments, source);
        // Once an OpenAI-style function envelope is recognized, its function/arguments subtree is
        // opaque domain data. Do not recursively reinterpret nested name/arguments pairs as calls.
        skipKeys.add("function");
      }
    }
    if (typeof object.name === "string" && object.arguments !== undefined) {
      register(object.name, object.arguments, source);
      skipKeys.add("arguments");
    }

    for (const [key, child] of Object.entries(object)) {
      if (!skipKeys.has(key)) visit(child);
    }
  };

  for (const candidate of completeJsonObjects(text)) {
    try {
      visit(JSON.parse(candidate));
    } catch {
      // Complete braces can still contain invalid JSON. Ambiguous recovery is intentionally rejected.
    }
  }
}

export function truncateKeepEnds(content: string, maxChars = 12000, indicator?: string): string {
  if (!content || content.length <= maxChars) return content;

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const head = content.slice(0, headChars);
  const tail = content.slice(content.length - tailChars);
  const omittedChars = content.length - maxChars;
  const marker =
    indicator ??
    `\n\n... [Truncated ${omittedChars.toLocaleString()} characters preserving head & tail] ...\n\n`;
  return `${head}${marker}${tail}`;
}
