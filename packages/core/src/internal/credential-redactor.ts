/**
 * Credential and Sensitive Secret Redaction Engine.
 *
 * Redaction is defense-in-depth: value-format rules catch recognizable credentials while
 * structured-object redaction also uses the field name so opaque secrets are not missed.
 */

export const REDACTED_MARKER = "<redacted>";

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replace: (substring: string, ...args: string[]) => string;
}

export interface RedactObjectOptions {
  /** Additional structured field names whose values must be removed in full. */
  sensitiveFields?: Iterable<string>;
}

export const CREDENTIAL_RULES: RedactionRule[] = [
  {
    name: "pem_private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY-----\n[${REDACTED_MARKER}]\n-----END PRIVATE KEY-----`,
  },
  {
    name: "bearer_token",
    pattern: /(Bearer\s+|QQBot\s+)[A-Za-z0-9._~+/=-]+/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED_MARKER}`,
  },
  {
    name: "auth_header",
    pattern:
      /((?:authorization|proxy-authorization|api-key|x-api-key|x-api-token|x-auth-key|x-auth-token|x-access-token|x-secret-key|client-secret|x-acs-dingtalk-access-token)\s*:\s*)(?:Basic\s+|Bearer\s+)?[^\r\n]+/gi,
    replace: (_match, header) => `${header}${REDACTED_MARKER}`,
  },
  {
    name: "cookie_header",
    pattern: /((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi,
    replace: (_match, header) => `${header}${REDACTED_MARKER}`,
  },
  {
    name: "sk_api_key",
    pattern: /sk-(?:ant-api03-|proj-)?[a-zA-Z0-9_-]{20,}/g,
    replace: () => `sk-${REDACTED_MARKER}`,
  },
  {
    name: "github_token",
    pattern: /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{20,}/g,
    replace: () => `ghp_${REDACTED_MARKER}`,
  },
  {
    name: "gitlab_token",
    pattern: /glpat-[a-zA-Z0-9_-]{20,}/g,
    replace: () => `glpat-${REDACTED_MARKER}`,
  },
  {
    name: "slack_token",
    pattern: /xox[baprs]-[a-zA-Z0-9-]{20,}/g,
    replace: () => `xoxb-${REDACTED_MARKER}`,
  },
  {
    name: "aws_access_key",
    pattern: /(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}/g,
    replace: () => `AKIA${REDACTED_MARKER}`,
  },
  {
    name: "aws_secret_key",
    pattern: /((?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*)[A-Za-z0-9/+=]{40}/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED_MARKER}`,
  },
  {
    name: "uri_credentials",
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@\s]+):([^@\s]+)@/g,
    replace: (_match, scheme, user) => `${scheme}${user}:${REDACTED_MARKER}@`,
  },
  {
    name: "generic_assignment",
    pattern:
      /((?:api[_-]?key|client[_-]?secret|password|passwd|pwd|access[_-]?token|secret[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key|secret[_-]?key|signing[_-]?secret|webhook[_-]?secret)\s*[:=]\s*["']?)[^\s"';,]{8,}(["']?)/gi,
    replace: (_match, prefix, quote) => `${prefix}${REDACTED_MARKER}${quote || ""}`,
  },
];

export function containsCredentials(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  return CREDENTIAL_RULES.some((rule) => {
    rule.pattern.lastIndex = 0;
    return rule.pattern.test(text);
  });
}

export function redactCredentials(text: string): string {
  if (!text || typeof text !== "string") return text;

  let result = text;
  for (const rule of CREDENTIAL_RULES) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.replace as any);
  }
  return result;
}

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const DEFAULT_SENSITIVE_FIELDS = new Set([
  "apikey",
  "xapikey",
  "apitoken",
  "xapitoken",
  "clientsecret",
  "clienttoken",
  "password",
  "passwd",
  "pwd",
  "accesstoken",
  "xaccesstoken",
  "xauthtoken",
  "xauthkey",
  "refreshtoken",
  "secrettoken",
  "sessiontoken",
  "authorization",
  "proxyauthorization",
  "auth",
  "credential",
  "credentials",
  "secret",
  "token",
  "privatekey",
  "secretkey",
  "xsecretkey",
  "signingsecret",
  "webhooksecret",
  "cookie",
  "setcookie",
  "awssecretaccesskey",
]);

function buildSensitiveFieldSet(options?: RedactObjectOptions): Set<string> {
  const set = new Set(DEFAULT_SENSITIVE_FIELDS);
  for (const field of options?.sensitiveFields ?? []) {
    const normalized = normalizeFieldName(field);
    if (normalized) set.add(normalized);
  }
  return set;
}

function isSensitiveField(key: string, sensitive: Set<string>): boolean {
  const normalized = normalizeFieldName(key);
  if (sensitive.has(normalized)) return true;

  return (
    /^(?:x|openai|anthropic|google|github|gitlab|slack|aws)?apikey$/.test(normalized) ||
    /^(?:client|app|oauth|webhook|signing)secret$/.test(normalized) ||
    /^(?:x)?(?:api|access|refresh|secret|session|auth|oauth|client)token$/.test(normalized) ||
    /^(?:x)?(?:auth|secret|private|signing|encryption)key$/.test(normalized) ||
    /^(?:set)?cookie$/.test(normalized)
  );
}

function redactSensitiveValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        redactSensitiveValue(child),
      ]),
    );
  }
  return REDACTED_MARKER;
}

/**
 * Recursively redact credentials while preserving the structured key context at every level.
 * Sensitive scalar fields are removed in full. Sensitive container fields retain their shape but
 * every leaf is redacted so callers do not lose object/array contracts while secrets stay opaque.
 */
export function redactObject<T>(input: T, options: RedactObjectOptions = {}): T {
  const sensitive = buildSensitiveFieldSet(options);

  const visit = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return redactCredentials(value);
    if (typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(visit);

    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = isSensitiveField(key, sensitive) ? redactSensitiveValue(child) : visit(child);
    }
    return copy;
  };

  return visit(input) as T;
}
