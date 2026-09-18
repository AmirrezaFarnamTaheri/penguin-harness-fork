/**
 * Provider preset catalog for the Universal Tool Mesh.
 *
 * Backed by 300 real provider presets distilled from the composio lineage's
 * `toolkits.json` (1,519 toolkits, 53,283 tools). The raw rows live in
 * {@link provider-presets.generated} — generated, not hand-edited — and this module is the
 * typed, queryable view over them.
 *
 * A "preset" here is the immutable shape of a provider: what it is called, how it
 * authenticates, how rich its tool surface is. It is deliberately *not* a credential, and
 * it holds no secret. The mesh binds a preset to a credential from
 * {@link EncryptedCredentialStore} at connection time.
 *
 * Selection absorbed from the corpus:
 *  - OAuth-capable providers rank first, because those are the ones PKCE serves.
 *  - `defaultScopes` are the provider's own documented defaults, captured so a connect
 *    flow can proceed without a second lookup (the composio `authConfigDetails` field).
 *  - The per-provider base-URL field allowlist (`subdomain`, `your-domain`, `region`,
 *    `shop`, `api_url`, ...) becomes {@link ProviderPreset.baseUrlFields}: the providers
 *    that need a tenant host get it, and the ones that do not are not asked for one.
 */
import { PROVIDER_PRESET_ROWS } from "./provider-presets.generated.js";
import {
  CREDENTIAL_AUTH_SCHEMES,
  type CredentialAuthScheme,
} from "./encrypted-credential-store.js";

export interface ProviderPreset {
  /** Mesh id — the source slug, lowercased and de-duplicated. */
  readonly id: string;
  readonly name: string;
  readonly category: string;
  /** Auth schemes the provider supports, in the provider's preference order. */
  readonly authSchemes: readonly CredentialAuthScheme[];
  /** Number of tools the provider exposes — a richness signal for ranking. */
  readonly toolCount: number;
  /** Default OAuth scopes to request when the caller gives none. */
  readonly defaultScopes?: readonly string[];
}

/**
 * Providers that need a tenant-specific host before they can be called. From the
 * composio `BaseSchemeRaw`: `subdomain` (ClickUp, Freshdesk), `region` (Mixpanel), `shop`
 * (Shopify), `your-domain` (Atlassian), `api_url` (ActiveCampaign), `dc` (Mailchimp),
 * `instanceName` (ServiceNow), `account_id` (NetSuite), `base_url` (self-hosted).
 */
export const BASE_URL_FIELDS: ReadonlyMap<string, string> = new Map([
  ["clickup", "subdomain"],
  ["freshdesk", "subdomain"],
  ["freshsales", "subdomain"],
  ["zoho", "subdomain"],
  ["mixpanel", "region"],
  ["shopify", "shop"],
  ["atlassian", "your-domain"],
  ["jira", "your-domain"],
  ["confluence", "your-domain"],
  ["activecampaign", "api_url"],
  ["mailchimp", "dc"],
  ["servicenow", "instanceName"],
  ["netsuite", "account_id"],
  ["pipedrive", "COMPANYDOMAIN"],
  ["salesforce", "instanceEndpoint"],
  ["d2l", "domain"],
  ["sharepoint", "site_name"],
  ["snowflake", "account_url"],
  ["formsite", "form_api_base_url"],
  ["ragic", "server_location"],
  ["borneo", "borneo_dashboard_url"],
  ["custom", "base_url"],
]);

const PRESETS: readonly ProviderPreset[] = PROVIDER_PRESET_ROWS.map((row) => {
  const [id, name, category, authSchemesJson, toolCount, scopesJson] = row;
  let parsed: unknown;
  try {
    parsed = JSON.parse(authSchemesJson);
  } catch {
    parsed = [];
  }
  const schemes = Array.isArray(parsed)
    ? parsed.filter(
        (scheme): scheme is CredentialAuthScheme =>
          typeof scheme === "string" &&
          (CREDENTIAL_AUTH_SCHEMES as readonly string[]).includes(scheme),
      )
    : [];
  const preset: ProviderPreset = {
    id,
    name,
    category,
    authSchemes: schemes,
    toolCount: Number.parseInt(toolCount, 10) || 0,
    ...presetScopes(scopesJson),
  };
  return preset;
});

function presetScopes(scopesJson: string | undefined): { defaultScopes?: readonly string[] } {
  if (scopesJson === undefined) return {};
  let scopes: unknown;
  try {
    scopes = JSON.parse(scopesJson);
  } catch {
    return {};
  }
  if (!Array.isArray(scopes) || scopes.length === 0) return {};
  return { defaultScopes: scopes as string[] };
}

/** Sorted by auth richness then tool count — the order the mesh recommends connections in. */
const BY_RANK: readonly ProviderPreset[] = [...PRESETS].sort((a, b) => {
  const rank = (preset: ProviderPreset): number =>
    preset.authSchemes.includes("OAUTH2")
      ? 1000
      : preset.authSchemes.includes("OAUTH1")
        ? 800
        : preset.authSchemes.includes("GOOGLE_SERVICE_ACCOUNT")
          ? 400
          : preset.authSchemes.includes("API_KEY")
            ? 200
            : preset.authSchemes.includes("BEARER_TOKEN")
              ? 100
              : 10;
  return rank(b) - rank(a) || b.toolCount - a.toolCount || a.id.localeCompare(b.id);
});

const BY_ID: ReadonlyMap<string, ProviderPreset> = new Map(
  PRESETS.map((preset) => [preset.id, preset]),
);

const BY_CATEGORY: ReadonlyMap<string, readonly ProviderPreset[]> = (() => {
  const groups = new Map<string, ProviderPreset[]>();
  for (const preset of PRESETS) {
    const bucket = groups.get(preset.category);
    if (bucket === undefined) groups.set(preset.category, [preset]);
    else bucket.push(preset);
  }
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => b.toolCount - a.toolCount || a.id.localeCompare(b.id));
  }
  return groups;
})();

/** Total providers in the catalog. */
export const PROVIDER_COUNT = PRESETS.length;

/** Total tools across every preset. */
export const PROVIDER_TOOL_TOTAL = PRESETS.reduce((sum, preset) => sum + preset.toolCount, 0);

/** Whether the mesh has a preset for an id. */
export function hasProvider(id: string): boolean {
  return BY_ID.has(id);
}

/** Fetches a preset by id. */
export function getProvider(id: string): ProviderPreset | undefined {
  return BY_ID.get(id);
}

/** Every preset, in rank order. */
export function listProviders(): readonly ProviderPreset[] {
  return BY_RANK;
}

/** Providers supporting a scheme, richest first. */
export function providersByScheme(scheme: CredentialAuthScheme): readonly ProviderPreset[] {
  return BY_RANK.filter((preset) => preset.authSchemes.includes(scheme));
}

/** All providers in a category, richest first. */
export function providersByCategory(category: string): readonly ProviderPreset[] {
  return BY_CATEGORY.get(category) ?? [];
}

/** Distinct categories present in the catalog. */
export function providerCategories(): readonly string[] {
  return [...BY_CATEGORY.keys()].sort((a, b) => a.localeCompare(b));
}

/**
 * Prefix + fuzzy search over names and ids. Prefix matches beat substring matches, which
 * beat fuzzy tolerance — so an exact `github` is never displaced by `hubspot` because
 * both contain a "b".
 */
export function searchProviders(query: string, limit: number = 10): readonly ProviderPreset[] {
  const term = query.trim().toLowerCase();
  if (term.length === 0) return BY_RANK.slice(0, limit);

  const scored: Array<{ preset: ProviderPreset; score: number }> = [];
  for (const preset of PRESETS) {
    const name = preset.name.toLowerCase();
    const id = preset.id.toLowerCase();
    let score = 0;
    if (id === term) score = 1000;
    else if (name === term) score = 900;
    else if (id.startsWith(term)) score = 800;
    else if (name.startsWith(term)) score = 700;
    else if (id.includes(term)) score = 500;
    else if (name.includes(term)) score = 400;
    else if (fuzzyMatch(name, term)) score = 200;
    if (score > 0) scored.push({ preset, score: score + Math.min(50, preset.toolCount / 10) });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.preset.id.localeCompare(b.preset.id))
    .slice(0, limit)
    .map((entry) => entry.preset);
}

/** Subsequence match — the cheap stand-in for the AnyTool lineage's embedding search. */
function fuzzyMatch(haystack: string, needle: string): boolean {
  let index = 0;
  for (let position = 0; position < haystack.length && index < needle.length; position++) {
    if (haystack[position] === needle[index]) index++;
  }
  return index === needle.length;
}

/**
 * The base-URL field a provider needs from a user, if any. Absent means the provider's
 * host is fixed and the caller should not prompt for one.
 */
export function baseUrlField(providerId: string): string | undefined {
  return BASE_URL_FIELDS.get(providerId);
}

/**
 * The scheme the mesh should negotiate first for a provider. OAuth2 wins because it is
 * the only one that can be refreshed unattended; service accounts are next because they
 * are also unattended; everything else needs a human to rotate it.
 */
export function preferredScheme(preset: ProviderPreset): CredentialAuthScheme | undefined {
  const order: CredentialAuthScheme[] = [
    "OAUTH2",
    "GOOGLE_SERVICE_ACCOUNT",
    "S2S_OAUTH2",
    "OAUTH1",
    "API_KEY",
    "BEARER_TOKEN",
    "BASIC",
    "NO_AUTH",
  ];
  for (const scheme of order) {
    if (preset.authSchemes.includes(scheme)) return scheme;
  }
  return preset.authSchemes[0];
}
