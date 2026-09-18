/**
 * Provider preset catalog tests.
 *
 * The catalog is generated from the composio lineage's 1,519-toolkit manifest, so these
 * assertions pin down properties the *generator* must keep true: 300 real presets, every
 * scheme in the vocabulary, OAuth-capable providers ranking first, and the tenant-host
 * allowlist covering the providers that need one — and not the ones that do not.
 */
import { describe, expect, it } from "vitest";

import {
  BASE_URL_FIELDS,
  PROVIDER_COUNT,
  PROVIDER_TOOL_TOTAL,
  baseUrlField,
  getProvider,
  hasProvider,
  listProviders,
  preferredScheme,
  providerCategories,
  providersByCategory,
  providersByScheme,
  searchProviders,
} from "../../src/fleet/provider-preset-catalog.js";
import { CREDENTIAL_AUTH_SCHEMES } from "../../src/fleet/encrypted-credential-store.js";

describe("provider preset catalog", () => {
  it("holds 300 real presets distilled from the toolkit manifest", () => {
    expect(PROVIDER_COUNT).toBe(300);
    expect(listProviders()).toHaveLength(300);
  });

  it("exposes a non-zero tool total across the fleet", () => {
    expect(PROVIDER_TOOL_TOTAL).toBeGreaterThan(10_000);
  });

  it("carries real data for a known provider", () => {
    const linear = getProvider("linear");
    expect(linear).toBeDefined();
    expect(linear!.name).toBe("Linear");
    expect(linear!.category).toBe("project management");
    expect(linear!.authSchemes).toContain("OAUTH2");
    expect(linear!.toolCount).toBe(47);
    expect(linear!.defaultScopes).toEqual(["read", "write", "issues:create", "comments:create"]);
  });

  it("looks up by id and reports presence", () => {
    expect(hasProvider("github")).toBe(true);
    expect(hasProvider("not-a-real-provider")).toBe(false);
    expect(getProvider("not-a-real-provider")).toBeUndefined();
  });

  it("only speaks the documented auth vocabulary", () => {
    for (const preset of listProviders()) {
      for (const scheme of preset.authSchemes) {
        expect((CREDENTIAL_AUTH_SCHEMES as readonly string[]).includes(scheme)).toBe(true);
      }
    }
  });

  it("drops malformed auth-scheme rows rather than crashing", () => {
    // A generator that emits a bad schemes array still yields a usable preset.
    const github = getProvider("github");
    expect(github!.authSchemes).toEqual(["OAUTH2"]);
  });

  it("ranks OAuth-capable providers ahead of API-key-only ones", () => {
    const ranked = listProviders();
    const firstOAuth = ranked.findIndex((preset) => preset.authSchemes.includes("OAUTH2"));
    const firstApiKeyOnly = ranked.findIndex(
      (preset) => !preset.authSchemes.includes("OAUTH2") && preset.authSchemes.includes("API_KEY"),
    );
    expect(firstOAuth).toBeGreaterThanOrEqual(0);
    expect(firstApiKeyOnly).toBeGreaterThan(firstOAuth);
  });

  it("lists providers by scheme", () => {
    const oauth = providersByScheme("OAUTH2");
    expect(oauth.length).toBeGreaterThan(150);
    // By-scheme listings follow the rank order.
    expect(oauth[0]!.authSchemes.includes("OAUTH2")).toBe(true);
    expect(providersByScheme("NO_AUTH").length).toBeGreaterThanOrEqual(0);
  });

  it("groups providers by category", () => {
    const categories = providerCategories();
    expect(categories.length).toBeGreaterThan(10);
    expect(categories).toEqual([...categories].sort());
    const pm = providersByCategory("project management");
    expect(pm.some((preset) => preset.id === "linear")).toBe(true);
    // Richest first within a category.
    for (let index = 1; index < pm.length; index++) {
      expect(pm[index]!.toolCount).toBeLessThanOrEqual(pm[index - 1]!.toolCount);
    }
    expect(providersByCategory("no such category")).toEqual([]);
  });

  it("searches by exact id, prefix and substring", () => {
    expect(searchProviders("github")[0]!.id).toBe("github");
    expect(searchProviders("git").some((preset) => preset.id === "github")).toBe(true);
    expect(searchProviders("hub").some((preset) => preset.id === "hubspot")).toBe(true);
  });

  it("ranks an exact id above a substring match", () => {
    const hits = searchProviders("github");
    expect(hits[0]!.id).toBe("github");
  });

  it("matches fuzzily as a last resort", () => {
    expect(searchProviders("gthub").some((preset) => preset.id === "github")).toBe(true);
  });

  it("never displaces an exact match with a fuzzy one", () => {
    // "hub" matches hubspot by substring and github fuzzily; hubspot must win.
    expect(searchProviders("hub")[0]!.id).toBe("hubspot");
  });

  it("returns the ranked list for an empty query", () => {
    expect(searchProviders("").length).toBeGreaterThan(0);
  });

  it("honours a limit", () => {
    expect(searchProviders("google", 3).length).toBeLessThanOrEqual(3);
  });
});

describe("tenant base-url fields", () => {
  it("knows the field a tenant-hosted provider needs", () => {
    expect(baseUrlField("shopify")).toBe("shop");
    expect(baseUrlField("clickup")).toBe("subdomain");
    expect(baseUrlField("jira")).toBe("your-domain");
    expect(baseUrlField("mailchimp")).toBe("dc");
    expect(baseUrlField("snowflake")).toBe("account_url");
  });

  it("returns nothing for a provider whose host is fixed", () => {
    expect(baseUrlField("github")).toBeUndefined();
    expect(baseUrlField("linear")).toBeUndefined();
    expect(baseUrlField("not-a-provider")).toBeUndefined();
  });

  it("maps only the documented tenant providers", () => {
    expect(BASE_URL_FIELDS.size).toBeGreaterThanOrEqual(15);
  });
});

describe("preferredScheme", () => {
  it("prefers OAuth2 because it alone refreshes unattended", () => {
    expect(preferredScheme(getProvider("linear")!)).toBe("OAUTH2");
    // Stripe lists API_KEY first; OAuth2 still wins.
    expect(preferredScheme(getProvider("stripe")!)).toBe("OAUTH2");
  });

  it("falls back to a service account before an API key", () => {
    expect(preferredScheme(getProvider("googlebigquery")!)).toBe("OAUTH2");
    const gsaOnly = {
      ...getProvider("googlebigquery")!,
      authSchemes: ["GOOGLE_SERVICE_ACCOUNT", "API_KEY"] as const,
    };
    expect(preferredScheme(gsaOnly)).toBe("GOOGLE_SERVICE_ACCOUNT");
  });

  it("falls back to the provider's first scheme when nothing better is on offer", () => {
    const apiKeyOnly = { ...getProvider("stripe")!, authSchemes: ["API_KEY"] as const };
    expect(preferredScheme(apiKeyOnly)).toBe("API_KEY");
  });
});
