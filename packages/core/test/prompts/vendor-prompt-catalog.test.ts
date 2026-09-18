import { describe, expect, it } from "vitest";

import {
  type PromptFamily,
  type VendorPromptEntry,
  CATALOGED_VENDOR_PROMPTS,
  VendorPromptCatalog,
} from "../../src/prompts/vendor-prompt-catalog.js";

/** Entry counts by family, as ported. A change here is a catalog change someone must see. */
const ANTHROPIC_ENTRIES = 19;
const IDE_ENTRIES = 19;
const CHAT_ENTRIES = 11;
const PERSONA_ENTRIES = 5;

describe("vendor-prompt-catalog / construction", () => {
  it("ships one entry per ported prompt with no duplicate ids", () => {
    const ids = CATALOGED_VENDOR_PROMPTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(ANTHROPIC_ENTRIES + IDE_ENTRIES + CHAT_ENTRIES + PERSONA_ENTRIES);
  });

  it("every id is a lowercase slug the catalog accepts", () => {
    for (const entry of CATALOGED_VENDOR_PROMPTS) {
      expect(entry.id).toMatch(/^[a-z0-9][a-z0-9-]*$/u);
      expect(entry.text.length).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("builds from the shipped prompts without error", () => {
    const catalog = new VendorPromptCatalog();
    expect(catalog.list().length).toBe(CATALOGED_VENDOR_PROMPTS.length);
  });

  it("rejects a duplicate id at registration", () => {
    const catalog = new VendorPromptCatalog();
    const first = CATALOGED_VENDOR_PROMPTS[0]!;
    expect(() => catalog.register({ ...first })).toThrow(/already registered/);
  });

  it("rejects an id that is not a lowercase slug", () => {
    const catalog = new VendorPromptCatalog();
    const base = CATALOGED_VENDOR_PROMPTS[0]!;
    expect(() => catalog.register({ ...base, id: "Not_A_Slug" })).toThrow(/lowercase slug/);
  });
});

describe("vendor-prompt-catalog / lookup", () => {
  it("gets, has and case-folds ids", () => {
    const catalog = new VendorPromptCatalog();
    expect(catalog.has("cline-system")).toBe(true);
    expect(catalog.has("CLINE-SYSTEM")).toBe(true);
    expect(catalog.get("cline-system")?.vendor).toBe("cline");
    expect(catalog.get("no-such-prompt")).toBeUndefined();
  });

  it("lists by family", () => {
    const catalog = new VendorPromptCatalog();
    expect(catalog.byFamilyId("persona").length).toBe(PERSONA_ENTRIES);
    expect(catalog.byFamilyId("chat").length).toBe(CHAT_ENTRIES);
    expect(catalog.byFamilyId("nope" as PromptFamily)).toEqual([]);
  });

  it("lists by vendor, including vendors with several entries", () => {
    const catalog = new VendorPromptCatalog();
    const parahelp = catalog.byVendorId("parahelp");
    expect(parahelp.map((e) => e.id).sort()).toEqual(
      ["parahelp-manager", "parahelp-planning"].sort(),
    );

    const anthropic = catalog.byVendorId("anthropicClaude");
    expect(anthropic.length).toBeGreaterThanOrEqual(1);
    expect(anthropic.every((e) => e.vendor === "anthropicClaude")).toBe(true);
  });

  it("reports the vendor roster", () => {
    const catalog = new VendorPromptCatalog();
    const vendors = catalog.vendors();
    expect(vendors.length).toBe(new Set(vendors).size);
    expect(vendors).toContain("parahelp");
    expect(vendors).toContain("clawdbot");
    expect(vendors).toEqual([...vendors].sort());
  });
});

describe("vendor-prompt-catalog / filters", () => {
  it("filters by family, format and provenance together", () => {
    const catalog = new VendorPromptCatalog();
    const xmlIde = catalog.list({ family: "ide", toolCallFormat: "xml-tags" });
    expect(xmlIde.length).toBeGreaterThan(0);
    for (const entry of xmlIde) {
      expect(entry.family).toBe("ide");
      expect(entry.toolCallFormat).toBe("xml-tags");
    }

    const official = catalog.list({ provenance: "official" });
    expect(official.length).toBeGreaterThan(0);
    expect(official.every((e) => e.provenance === "official")).toBe(true);
  });

  it("excludes truncated entries when completeOnly is set", () => {
    const catalog = new VendorPromptCatalog();
    const truncated = catalog.list().filter((e) => e.truncated);
    expect(truncated.length).toBeGreaterThan(0);
    for (const entry of catalog.list({ completeOnly: true })) {
      expect(entry.truncated).toBeUndefined();
    }
  });

  it("matches a free-text query against name and description", () => {
    const catalog = new VendorPromptCatalog();
    const hits = catalog.list({ query: "privacy" });
    expect(hits.length).toBeGreaterThan(0);
    for (const entry of hits) {
      const haystack = `${entry.name} ${entry.description} ${entry.vendor}`.toLowerCase();
      expect(haystack).toContain("privacy");
    }
    expect(catalog.list({ query: "zzz-no-match-zzz" })).toEqual([]);
  });
});

describe("vendor-prompt-catalog / integrity", () => {
  // The two contracts the catalog exists to enforce: nothing ships with another harness's
  // control markers, and no two entries are the same prompt under two ids.
  it("no entry carries a harness-injection marker", () => {
    const catalog = new VendorPromptCatalog();
    expect(catalog.stats().entriesWithMarkers).toBe(0);
    for (const entry of CATALOGED_VENDOR_PROMPTS) {
      expect(catalog.markers(entry.id)).toEqual([]);
    }
  });

  it("has no duplicate normalised digests", () => {
    const catalog = new VendorPromptCatalog();
    expect(catalog.stats().duplicateDigests).toBe(0);
    expect(() => catalog.assertNoDuplicates()).not.toThrow();
  });

  it("truncated entries record the size of the text they omit", () => {
    const catalog = new VendorPromptCatalog();
    const truncated = catalog.list().filter((e) => e.truncated);
    for (const entry of truncated) {
      expect(entry.sourceBytes).toBeGreaterThan(entry.text.length);
    }
  });

  it("normalised text strips markers and canonicalises whitespace", () => {
    const catalog = new VendorPromptCatalog();
    const normalized = catalog.normalizedText("cline-system");
    expect(normalized).toBeDefined();
    expect(normalized).not.toContain("<system-reminder>");
    expect(normalized).not.toMatch(/[ \t]$/mu);
  });

  it("fingerprints every entry", () => {
    const catalog = new VendorPromptCatalog();
    const fp = catalog.fingerprint("cline-system");
    expect(fp).toBeDefined();
    expect(fp!.algorithm).toBe("fnv1a-64");
    expect(fp!.digest).toHaveLength(16);
  });

  it("reports aggregate statistics", () => {
    const catalog = new VendorPromptCatalog();
    const stats = catalog.stats();
    expect(stats.entries).toBe(CATALOGED_VENDOR_PROMPTS.length);
    expect(stats.vendors).toBe(catalog.vendors().length);
    expect(stats.families).toBe(4);
    expect(stats.toolCallFormats).toBeGreaterThanOrEqual(2);
    expect(stats.truncated).toBeGreaterThan(0);
    expect(stats.chars).toBeGreaterThan(0);
    expect(stats.estTokens).toBeGreaterThan(0);
  });
});

describe("vendor-prompt-catalog / persona family", () => {
  it("ports the ship's-brain identity and voice as two entries", () => {
    const catalog = new VendorPromptCatalog();
    const identity = catalog.get("clawdbot-identity");
    expect(identity).toBeDefined();
    expect(identity!.family).toBe("persona");
    // The cardinal privacy rule is quoted verbatim, not paraphrased.
    expect(identity!.text).toContain("What happens on the bridge stays on the bridge.");
    expect(identity!.text).toContain("NEVER share any of it in conversations with other people");

    const soul = catalog.get("clawdbot-soul");
    expect(soul).toBeDefined();
    expect(soul!.text).toContain("Don't be sycophantic (that's a Sirius Cybernetics thing");
  });

  it("ports the supervisor gate and its plan dialect", () => {
    const catalog = new VendorPromptCatalog();
    const manager = catalog.get("parahelp-manager");
    expect(manager).toBeDefined();
    expect(manager!.toolCallFormat).toBe("xml-tags");
    expect(manager!.text).toContain("<manager_verify>accept</manager_verify>");
    expect(manager!.text).toContain("<manager_feedback>reject</manager_feedback>");

    const planning = catalog.get("parahelp-planning");
    expect(planning).toBeDefined();
    expect(planning!.text).toContain("<if_block condition='");
    expect(planning!.text).toContain("NEVER assumes any information");
  });

  it("ports the values constitution", () => {
    const catalog = new VendorPromptCatalog();
    const spark = catalog.get("meta-spark-persona");
    expect(spark).toBeDefined();
    expect(spark!.truncated).toBe(true);
    expect(spark!.text).toContain("Simplification without request is condescension");
    expect(spark!.text).toContain("Talk up to the user");
  });
});

describe("vendor-prompt-catalog / hand-written entry shape", () => {
  it("accepts a caller-supplied entry alongside the shipped set", () => {
    const catalog = new VendorPromptCatalog();
    const custom: VendorPromptEntry = {
      id: "local-experimental",
      vendor: "piHarness",
      family: "persona",
      name: "Local experimental persona",
      description: "A caller-registered entry for testing the registry path.",
      text: "You are a local experimental agent.",
      toolCallFormat: "none",
      provenance: "distilled",
    };
    catalog.register(custom);
    expect(catalog.get("local-experimental")?.vendor).toBe("piHarness");
    expect(catalog.byVendorId("piHarness").map((e) => e.id)).toContain("local-experimental");
  });
});
