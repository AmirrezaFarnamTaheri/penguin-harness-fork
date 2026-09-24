/**
 * The three catalog normalizers that shape every provider/model catalog the UI renders.
 *
 * `model-combo-fallback.test.ts` covers the fallback cascade (`ModelComboRegistry`); the pure
 * functions the cascade's inputs are keyed through were untested. Each one is a single
 * table or split, so the failure mode is silent and total — an alias typo re-keys a whole
 * provider, and a `:`-split regression drops every variant-suffixed model.
 */
import { describe, expect, it } from "vitest";

import {
  baseModelId,
  normalizeProvider,
  PROVIDER_ALIASES,
  slimModelCatalog,
} from "../../src/llm/model-combos.js";

/**
 * The alias table as written in the source, asserted wholesale so a typo or a dropped entry
 * is caught here rather than by a model vanishing from a catalog.
 */
const EXPECTED_ALIASES: Record<string, string> = {
  glm: "zai",
  "glm-cn": "zhipuai",
  claude: "anthropic",
  gemini: "google",
  kimi: "moonshotai",
  "kimi-cn": "moonshotai-cn",
  qwen: "alibaba",
  "qwen-cn": "alibaba-cn",
  zhipu: "zhipuai",
  hunyuan: "tencent",
  doubao: "volcengine",
  "cloudflare-ai": "cloudflare-workers-ai",
};

/** A raw catalog entry in the shape `slimModelCatalog` consumes. */
function rawModel(
  input: string[],
  context?: number,
  output?: number,
  reasoning?: boolean,
): Record<string, unknown> {
  return {
    modalities: { input },
    limit: { context, output },
    reasoning,
  };
}

describe("normalizeProvider", () => {
  it("maps every alias in the table to its canonical provider", () => {
    expect(PROVIDER_ALIASES).toEqual(EXPECTED_ALIASES);
    for (const [alias, canonical] of Object.entries(EXPECTED_ALIASES)) {
      expect(normalizeProvider(alias)).toBe(canonical);
    }
  });

  it("applies the alias regardless of case and surrounding whitespace", () => {
    expect(normalizeProvider("GLM")).toBe("zai");
    expect(normalizeProvider("  glm  ")).toBe("zai");
    expect(normalizeProvider("Claude")).toBe("anthropic");
    expect(normalizeProvider("KIMI-CN")).toBe("moonshotai-cn");
    expect(normalizeProvider("\tcloudflare-ai\n")).toBe("cloudflare-workers-ai");
  });

  it("passes an unknown provider through, trimmed and lowercased", () => {
    expect(normalizeProvider("openai")).toBe("openai");
    expect(normalizeProvider(" MistralAI ")).toBe("mistralai");
    // A canonical name is not itself an alias key, so it round-trips.
    expect(normalizeProvider("zai")).toBe("zai");
    expect(normalizeProvider("anthropic")).toBe("anthropic");
    // An empty string is not aliased and stays empty.
    expect(normalizeProvider("")).toBe("");
  });

  it("does not chain aliases transitively", () => {
    // `glm` resolves to `zai`, and `zai` is a canonical name rather than an alias of something
    // further — one hop only, so a cycle or a chain of aliases cannot silently re-key a provider.
    expect(normalizeProvider(normalizeProvider("glm"))).toBe("zai");
    // `zhipu` and `glm-cn` both land on `zhipuai`, but neither resolves through the other.
    expect(normalizeProvider("zhipu")).toBe("zhipuai");
    expect(normalizeProvider("glm-cn")).toBe("zhipuai");
    expect(normalizeProvider(normalizeProvider("zhipu"))).toBe("zhipuai");
  });
});

describe("baseModelId", () => {
  it("strips a vendor prefix and a variant suffix in every combination", () => {
    // The four shapes: bare, prefixed, suffixed, both.
    expect(baseModelId("gpt-4o")).toBe("gpt-4o");
    expect(baseModelId("openai/gpt-4o")).toBe("gpt-4o");
    expect(baseModelId("gpt-4o:2024-08-06")).toBe("gpt-4o");
    expect(baseModelId("openai/gpt-4o:2024-08-06")).toBe("gpt-4o");
  });

  it("keeps the component after the vendor prefix when the id also carries a variant", () => {
    // The `!` on the split is load-bearing here: `a/b:c` splits to `b:c`, then `:` to `b`.
    // One off-by-one in that chain and this returns "" instead of "b".
    expect(baseModelId("a/b:c")).toBe("b");
    expect(baseModelId("provider/model:v1")).toBe("model");
    expect(baseModelId("deepseek/deepseek-chat:v3.1")).toBe("deepseek-chat");
  });

  it("lowercases the result", () => {
    expect(baseModelId("OpenAI/GPT-4o")).toBe("gpt-4o");
    expect(baseModelId("GPT-4o:Latest")).toBe("gpt-4o");
  });

  it("takes the last path component when the vendor prefix is itself namespaced", () => {
    expect(baseModelId("a/b/c:d")).toBe("c");
    expect(baseModelId("/x")).toBe("x");
    // A colon inside the vendor prefix is never treated as a variant boundary.
    expect(baseModelId("a:b/c")).toBe("c");
  });

  it("degenerates to an empty base rather than throwing", () => {
    expect(baseModelId("")).toBe("");
    expect(baseModelId(":")).toBe("");
    expect(baseModelId("/")).toBe("");
    expect(baseModelId("::")).toBe("");
  });
});

describe("slimModelCatalog", () => {
  it("collapses two variant ids onto one base id, keeping the first by model id order", () => {
    const catalog = slimModelCatalog({
      provider: {
        models: {
          // Inserted out of order: the merge is by sorted model id, not by object order.
          "provider/model:v2": rawModel(["text", "video"], 2000, 8000, true),
          "provider/model:v1": rawModel(["text", "image"], 1000, 4000, false),
        },
      },
    });

    expect(Object.keys(catalog)).toEqual(["provider"]);
    expect(Object.keys(catalog.provider!)).toEqual(["model"]);
    expect(catalog.provider!.model).toEqual({
      inputModalities: ["image"],
      contextLimit: 1000,
      outputLimit: 4000,
      supportsReasoning: false,
    });
  });

  it("skips a later model whose base id already survived normalisation", () => {
    const catalog = slimModelCatalog({
      provider: {
        models: {
          "provider/model": rawModel(["text", "image"], 1000),
          // Same base id after the variant suffix is stripped: dropped, not merged or overwritten.
          "provider/model:v2": rawModel(["text", "video"], 9999),
        },
      },
    });
    expect(Object.keys(catalog.provider!)).toEqual(["model"]);
    expect(catalog.provider!.model!.contextLimit).toBe(1000);
    // A genuinely distinct base id still lands in the same provider.
    const withOther = slimModelCatalog({
      provider: {
        models: {
          "provider/model:v1": rawModel(["text"], 1000),
          "provider/other:v1": rawModel(["text"], 2000),
        },
      },
    });
    expect(Object.keys(withOther.provider!).sort()).toEqual(["model", "other"]);
  });

  it("drops text from the input modalities and leaves every other modality in place", () => {
    const catalog = slimModelCatalog({
      provider: {
        models: {
          "provider/multimodal": rawModel(["text", "image", "audio", "file"]),
          "provider/text-only": rawModel(["text"]),
          "provider/no-text": rawModel(["image"]),
          "provider/none": { modalities: {} },
          "provider/absent": {},
        },
      },
    });
    const models = catalog.provider!;
    expect(models.multimodal!.inputModalities).toEqual(["image", "audio", "file"]);
    expect(models["text-only"]!.inputModalities).toEqual([]);
    expect(models["no-text"]!.inputModalities).toEqual(["image"]);
    expect(models.none!.inputModalities).toEqual([]);
    expect(models.absent!.inputModalities).toEqual([]);
    // The emitted array is a copy, so a caller mutating it cannot corrupt the catalog input.
    expect(models.multimodal!.inputModalities).not.toBe(
      (rawModel(["text", "image"]) as { modalities: { input: string[] } }).modalities.input,
    );
  });

  it("maps limit and reasoning fields onto the slim entry shape", () => {
    const catalog = slimModelCatalog({
      provider: {
        models: {
          "provider/reasoning": rawModel(["text"], 128_000, 8_192, true),
          "provider/plain": rawModel(["text"], undefined, undefined, false),
          "provider/unset": rawModel(["text"]),
        },
      },
    });
    const models = catalog.provider!;
    expect(models.reasoning).toEqual({
      inputModalities: [],
      contextLimit: 128_000,
      outputLimit: 8_192,
      supportsReasoning: true,
    });
    expect(models.plain!.contextLimit).toBeUndefined();
    expect(models.plain!.outputLimit).toBeUndefined();
    expect(models.plain!.supportsReasoning).toBe(false);
    expect(models.unset!.supportsReasoning).toBe(false);
  });

  it("merges an alias provider key and its canonical key under the canonical name", () => {
    const catalog = slimModelCatalog({
      // `glm` is an alias of `zai`; both keys normalise to `zai`.
      glm: {
        models: {
          "glm/glm-4.6": rawModel(["text"], 1000, 4000, false),
          "glm/glm-flash": rawModel(["text"], 2000),
        },
      },
      zai: {
        models: {
          "zai/glm-4.6": rawModel(["text", "image"], 2000, 8000, true),
        },
      },
    });

    expect(Object.keys(catalog)).toEqual(["zai"]);
    // The duplicate base id is skipped, and the canonical key's entry wins the conflict.
    expect(Object.keys(catalog.zai!).sort()).toEqual(["glm-4.6", "glm-flash"]);
    expect(catalog.zai!["glm-4.6"]!).toEqual({
      inputModalities: ["image"],
      contextLimit: 2000,
      outputLimit: 8000,
      supportsReasoning: true,
    });
    // The alias key's non-colliding model is still carried across.
    expect(catalog.zai!["glm-flash"]!.contextLimit).toBe(2000);
  });

  it("normalizes the provider keys it emits", () => {
    const catalog = slimModelCatalog({
      claude: { models: { "claude/opus-4": rawModel(["text"]) } },
      " KIMI ": { models: { "kimi/k2": rawModel(["text"]) } },
      openai: { models: { "openai/gpt-4o": rawModel(["text"]) } },
    });
    expect(Object.keys(catalog).sort()).toEqual(["anthropic", "moonshotai", "openai"]);
    expect(catalog.anthropic!["opus-4"]).toBeDefined();
    expect(catalog.moonshotai!["k2"]).toBeDefined();
    expect(catalog.openai!["gpt-4o"]).toBeDefined();
  });

  it("emits an empty object for an empty catalog or a provider with no models", () => {
    expect(slimModelCatalog({})).toEqual({});
    // The emitted key is the normalized provider id, so the casing of a raw key is not
    // preserved even when the provider contributes nothing.
    const catalog = slimModelCatalog({
      empty: { models: {} },
      noModelsField: {},
      nullish: { models: null },
    });
    expect(Object.keys(catalog).sort()).toEqual(["empty", "nomodelsfield", "nullish"]);
    for (const provider of Object.values(catalog)) {
      expect(provider).toEqual({});
    }
  });

  it("keeps the entry that carries the limits when two listings share a base id", () => {
    // The dedup is deliberate (`openai/gpt-4o` vs `gpt-4o`), but which listing survives used
    // to be the accident of sort order. A gateway listing that actually reports the context
    // and output limits now wins over a stub that omits them, so the survivor is the more
    // informative listing rather than the lexicographically first one.
    const catalog = slimModelCatalog({
      provider: {
        models: {
          // Sorted order puts the limit-less listing first; sort order alone would keep it.
          "provider/model": rawModel(["text", "image"]),
          "provider/model:v2": rawModel(["text"], 1000, 4000, false),
        },
      },
    });
    expect(catalog.provider!.model).toEqual({
      inputModalities: [],
      contextLimit: 1000,
      outputLimit: 4000,
      supportsReasoning: false,
    });
    // When both listings carry limits, the sorted order still decides, which is the
    // behaviour the dedup had before.
    const both = slimModelCatalog({
      provider: {
        models: {
          "provider/model:v1": rawModel(["text"], 1000, 4000, false),
          "provider/model:v2": rawModel(["text"], 2000, 8000, true),
        },
      },
    });
    expect(both.provider!.model!.contextLimit).toBe(1000);
    expect(both.provider!.model!.outputLimit).toBe(4000);
  });

  it("keeps complementary limits from duplicate listings", () => {
    const catalog = slimModelCatalog({
      provider: {
        models: {
          "provider/model:v1": rawModel(["text"], 1000),
          "provider/model:v2": rawModel(["text"], undefined, 4000),
        },
      },
    });
    expect(catalog.provider!.model).toMatchObject({ contextLimit: 1000, outputLimit: 4000 });
  });

  it("skips a model id that normalises to the empty string", () => {
    // `baseModelId("/")` and `baseModelId("::")` are "". Keying them would collide every
    // malformed id onto one slot and hand a caller an entry it cannot name.
    const catalog = slimModelCatalog({
      provider: {
        models: {
          "/": rawModel(["text"], 1000),
          "::": rawModel(["text"], 2000),
          "provider/real": rawModel(["text"], 3000),
        },
      },
    });
    expect(Object.keys(catalog.provider!)).toEqual(["real"]);
  });
});
