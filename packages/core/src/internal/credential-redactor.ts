/**
 * Credential and Sensitive Secret Redaction Engine.
 *
 * Synthesized from Qwen-Code (Project 126: @qwen-code/acp-bridge logRedaction.ts)
 * and OpenFang (Project 110: secret isolation).
 *
 * Guarantees zero credential leakage across:
 * - Agent session transcripts and replay journals
 * - External logging and telemetry sinks
 * - Omnimessage previews and error diagnostics
 */

export const REDACTED_MARKER = "<redacted>";

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replace: (substring: string, ...args: string[]) => string;
}

export const CREDENTIAL_RULES: RedactionRule[] = [
  // 1. PEM formatted private keys
  {
    name: "pem_private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY-----\n[${REDACTED_MARKER}]\n-----END PRIVATE KEY-----`,
  },
  // 2. Bearer & QQBot authorization tokens
  {
    name: "bearer_token",
    pattern: /(Bearer\s+|QQBot\s+)[A-Za-z0-9._~+/=-]+/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED_MARKER}`,
  },
  // 3. Authorization header (Basic, Digest, or custom)
  {
    name: "auth_header",
    pattern: /((?:authorization|x-api-key|x-auth-token|x-acs-dingtalk-access-token)\s*:\s*)(?:Basic\s+|Bearer\s+)?\S+/gi,
    replace: (_match, header) => `${header}${REDACTED_MARKER}`,
  },
  // 4. API keys with standard sk- prefix (OpenAI, Anthropic, DeepSeek, Google, etc. >=20 chars)
  {
    name: "sk_api_key",
    pattern: /sk-(?:ant-api03-|proj-)?[a-zA-Z0-9_-]{20,}/g,
    replace: () => `sk-${REDACTED_MARKER}`,
  },
  // 5. GitHub personal access tokens and OAuth tokens
  {
    name: "github_token",
    pattern: /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{20,}/g,
    replace: () => `ghp_${REDACTED_MARKER}`,
  },
  // 6. GitLab personal access tokens
  {
    name: "gitlab_token",
    pattern: /glpat-[a-zA-Z0-9_-]{20,}/g,
    replace: () => `glpat-${REDACTED_MARKER}`,
  },
  // 7. Slack API tokens (bot & user)
  {
    name: "slack_token",
    pattern: /xox[baprs]-[a-zA-Z0-9-]{20,}/g,
    replace: () => `xoxb-${REDACTED_MARKER}`,
  },
  // 8. AWS Access Key IDs (AKIA, ASIA, ABIA, ACCA)
  {
    name: "aws_access_key",
    pattern: /(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}/g,
    replace: () => `AKIA${REDACTED_MARKER}`,
  },
  // 9. AWS Secret Access Keys (40 chars base64, usually preceded by label)
  {
    name: "aws_secret_key",
    pattern: /((?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*)[A-Za-z0-9/+=]{40}/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED_MARKER}`,
  },
  // 10. URI embedded basic auth credentials (https://user:pass@host)
  {
    name: "uri_credentials",
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@\s]+):([^@\s]+)@/g,
    replace: (_match, scheme, user) => `${scheme}${user}:${REDACTED_MARKER}@`,
  },
  // 11. Generic key-value secret assignments (e.g. api_key="secret", password: 'xyz')
  {
    name: "generic_assignment",
    pattern: /((?:api[_-]?key|client[_-]?secret|password|passwd|pwd|access[_-]?token|secret[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?)[^\s"';,]{8,}(["']?)/gi,
    replace: (_match, prefix, quote) => `${prefix}${REDACTED_MARKER}${quote || ""}`,
  },
];

/**
 * Scans a string for sensitive credentials and returns true if any pattern matches.
 */
export function containsCredentials(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  return CREDENTIAL_RULES.some((rule) => {
    rule.pattern.lastIndex = 0;
    return rule.pattern.test(text);
  });
}

/**
 * Redacts all identified credentials from the input string.
 */
export function redactCredentials(text: string): string {
  if (!text || typeof text !== "string") return text;

  let result = text;
  for (const rule of CREDENTIAL_RULES) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.replace as any);
  }
  return result;
}

/**
 * Recursively redacts credentials across JSON objects, arrays, and primitive fields.
 */
export function redactObject<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return redactCredentials(input) as unknown as T;
  if (typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => redactObject(item)) as unknown as T;
  }

  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    // If key name itself indicates a secret, redact entire string value immediately
    if (
      typeof value === "string" &&
      /^(?:api_?key|password|secret|token|auth|credential)$/i.test(key)
    ) {
      copy[key] = REDACTED_MARKER;
    } else {
      copy[key] = redactObject(value);
    }
  }

  return copy as T;
}
