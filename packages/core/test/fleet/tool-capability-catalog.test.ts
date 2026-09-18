/**
 * Tool capability catalog tests — intent-based discovery over the mesh's tool surface.
 *
 * The ranking assertions are the ones that break if the scorer is faked: a query for
 * "send a message" must rank `message.send` above an unrelated capability, and a query that
 * matches nothing must return nothing rather than an arbitrary top-N.
 */
import { describe, expect, it } from "vitest";

import {
  BUILTIN_CAPABILITY_ROWS,
  CAPABILITY_ACCESS,
  CAPABILITY_SEARCH_MODE,
  CapabilityCatalogError,
  HYBRID_RANKER,
  ToolCapabilityCatalog,
  createBuiltinCapabilityCatalog,
  idTokens,
  keywordScore,
  seedCapabilityCatalog,
  semanticScore,
  tokenize,
} from "../../src/fleet/tool-capability-catalog.js";

describe("tokenize and idTokens", () => {
  it("splits on punctuation and case-folds", () => {
    expect(tokenize("Send a Message!")).toEqual(["send", "message"]);
  });

  it("drops stop words so they cannot dominate a short query", () => {
    expect(tokenize("get the list of issues")).toEqual(["issues"]);
  });

  it("turns dotted ids into words", () => {
    expect(idTokens("message.send")).toEqual(["message", "send"]);
    expect(idTokens("pull_request.open")).toEqual(["pull", "request", "open"]);
    expect(idTokens("")).toEqual([]);
  });
});

describe("scoring", () => {
  const capability = {
    id: "message.send",
    intent: "Send a message to a channel or conversation",
    category: "team chat",
    access: CAPABILITY_ACCESS.Write,
    inputs: [
      { name: "channel", type: "text" },
      { name: "body", type: "text" },
    ],
    tools: ["slack"],
  };

  it("scores a full keyword match at 1", () => {
    expect(keywordScore(capability, "send message")).toBe(1);
  });

  it("scores a partial keyword match between 0 and 1", () => {
    expect(keywordScore(capability, "send email")).toBeCloseTo(0.5, 5);
  });

  it("scores an empty query at 0", () => {
    expect(keywordScore(capability, "")).toBe(0);
    expect(semanticScore(capability, "the and of")).toBe(0);
  });

  it("rewards query tokens appearing in intent order", () => {
    // A full in-order match reaches the coverage cap plus the ordering bonus.
    expect(semanticScore(capability, "send message")).toBe(1);
    // A partial match scores only its coverage, with no ordering bonus.
    expect(semanticScore(capability, "send email")).toBeCloseTo(0.5, 5);
    expect(semanticScore(capability, "send message")).toBeGreaterThan(
      semanticScore(capability, "send email"),
    );
  });

  it("blends keyword and semantic in the hybrid ranker", () => {
    const hybrid = HYBRID_RANKER.rank(capability, "send message");
    expect(hybrid).toBeGreaterThan(0);
    expect(hybrid).toBeLessThanOrEqual(1);
  });
});

describe("ToolCapabilityCatalog", () => {
  it("registers and looks up a capability", () => {
    const catalog = new ToolCapabilityCatalog();
    catalog.register({
      id: "issue.create",
      intent: "Create an issue",
      category: "project management",
      access: CAPABILITY_ACCESS.Write,
      inputs: [],
      tools: ["linear", "jira"],
    });
    expect(catalog.get("issue.create")?.tools).toEqual(["linear", "jira"]);
    expect(catalog.require("issue.create").id).toBe("issue.create");
    expect(catalog.size).toBe(1);
  });

  it("throws on a duplicate id", () => {
    const catalog = new ToolCapabilityCatalog();
    catalog.register({
      id: "x",
      intent: "i",
      category: "c",
      access: CAPABILITY_ACCESS.Read,
      inputs: [],
      tools: [],
    });
    expect(() =>
      catalog.register({
        id: "x",
        intent: "i",
        category: "c",
        access: CAPABILITY_ACCESS.Read,
        inputs: [],
        tools: [],
      }),
    ).toThrow(/already registered/);
  });

  it("requires an id and an intent", () => {
    const catalog = new ToolCapabilityCatalog();
    expect(() =>
      catalog.register({
        id: "",
        intent: "i",
        category: "c",
        access: CAPABILITY_ACCESS.Read,
        inputs: [],
        tools: [],
      }),
    ).toThrow(/requires an id and an intent/);
  });

  it("throws on requiring an unknown capability", () => {
    expect(() => new ToolCapabilityCatalog().require("nope")).toThrow(CapabilityCatalogError);
  });

  it("indexes capabilities by tool and by category", () => {
    const catalog = new ToolCapabilityCatalog();
    catalog.register({
      id: "issue.create",
      intent: "Create an issue",
      category: "pm",
      access: CAPABILITY_ACCESS.Write,
      inputs: [],
      tools: ["linear"],
    });
    expect(catalog.capabilitiesForTool("linear")).toHaveLength(1);
    expect(catalog.capabilitiesForTool("unknown")).toEqual([]);
    expect(catalog.capabilitiesByCategory("pm")).toHaveLength(1);
    expect(catalog.capabilitiesByCategory("nope")).toEqual([]);
    expect(catalog.toolCount).toBe(1);
  });

  it("searches and ranks by relevance", () => {
    const catalog = createBuiltinCapabilityCatalog();
    const hits = catalog.search("send a message to a channel");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe("message.send");
    // A read-only filter excludes the write capability.
    expect(catalog.search("send a message", { access: CAPABILITY_ACCESS.Read })[0]?.id).toBe(
      "message.read",
    );
  });

  it("returns nothing for a query that matches nothing", () => {
    const catalog = createBuiltinCapabilityCatalog();
    expect(catalog.search("zzzzq")).toHaveLength(0);
  });

  it("honours the limit", () => {
    const catalog = createBuiltinCapabilityCatalog();
    expect(catalog.search("issue", { limit: 2 }).length).toBeLessThanOrEqual(2);
  });

  it("ranks keyword mode purely on token coverage", () => {
    const catalog = createBuiltinCapabilityCatalog();
    const hybrid = catalog.search("create a task", { mode: CAPABILITY_SEARCH_MODE.Hybrid });
    const keyword = catalog.search("create a task", { mode: CAPABILITY_SEARCH_MODE.Keyword });
    expect(hybrid.length).toBeGreaterThan(0);
    expect(keyword.length).toBeGreaterThan(0);
    expect(hybrid[0]!.score).toBeGreaterThanOrEqual(keyword[0]!.score);
  });

  it("resolves a natural-language request to tool ids", () => {
    const catalog = createBuiltinCapabilityCatalog();
    const tools = catalog.resolveTools("list issues in a tracker");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]!.capabilityId).toBe("issue.list");
    expect(tools.some((hit) => hit.toolId === "linear")).toBe(true);
    // Ranked best-first.
    for (let index = 1; index < tools.length; index++) {
      expect(tools[index]!.score).toBeLessThanOrEqual(tools[index - 1]!.score);
    }
  });

  it("names exactly the tools a matched capability declares", () => {
    const catalog = new ToolCapabilityCatalog();
    catalog.register({
      id: "orphan.intent",
      intent: "Do something nothing supports",
      category: "misc",
      access: CAPABILITY_ACCESS.Read,
      inputs: [],
      tools: ["no-such-tool"],
    });
    const resolved = catalog.resolveTools("do something nothing supports");
    // The catalog reports what the capability declares — it has no notion of which tools
    // are installed, so a tool the mesh never registered still resolves here. Whether that
    // tool exists, is bound, and is callable is the mesh registry's discovery contract
    // (see tool-mesh-registry.test.ts: discovery excludes unregistered and unbound tools).
    expect(resolved).toEqual([
      { toolId: "no-such-tool", score: expect.any(Number), capabilityId: "orphan.intent" },
    ]);
  });

  it("removes a capability and its index entries", () => {
    const catalog = new ToolCapabilityCatalog();
    catalog.register({
      id: "x",
      intent: "i",
      category: "c",
      access: CAPABILITY_ACCESS.Read,
      inputs: [],
      tools: ["tool-a"],
    });
    expect(catalog.remove("x")).toBe(true);
    expect(catalog.remove("x")).toBe(false);
    expect(catalog.size).toBe(0);
    expect(catalog.capabilitiesForTool("tool-a")).toEqual([]);
    expect(catalog.stats()).toEqual({ capabilities: 0, categories: 0, tools: 0 });
  });

  it("fires a listener on registration and stops on unsubscribe", () => {
    const catalog = new ToolCapabilityCatalog();
    const seen: string[] = [];
    const unsubscribe = catalog.onCapability((capability) => seen.push(capability.id));
    catalog.register({
      id: "x",
      intent: "i",
      category: "c",
      access: CAPABILITY_ACCESS.Read,
      inputs: [],
      tools: [],
    });
    unsubscribe();
    catalog.register({
      id: "y",
      intent: "i",
      category: "c",
      access: CAPABILITY_ACCESS.Read,
      inputs: [],
      tools: [],
    });
    expect(seen).toEqual(["x"]);
  });

  it("survives a throwing listener", () => {
    const catalog = new ToolCapabilityCatalog();
    catalog.onCapability(() => {
      throw new Error("listener blew up");
    });
    expect(() =>
      catalog.register({
        id: "x",
        intent: "i",
        category: "c",
        access: CAPABILITY_ACCESS.Read,
        inputs: [],
        tools: [],
      }),
    ).not.toThrow();
  });
});

describe("seedCapabilityCatalog", () => {
  it("parses compact input rows, marking required ones", () => {
    const catalog = new ToolCapabilityCatalog();
    const count = seedCapabilityCatalog(catalog, [
      ["x.do", "Do a thing", "cat", CAPABILITY_ACCESS.Write, ["tool-a"], "name:text!, limit:int"],
    ]);
    expect(count).toBe(1);
    const capability = catalog.require("x.do");
    expect(capability.inputs).toEqual([
      { name: "name", type: "text", required: true },
      { name: "limit", type: "int" },
    ]);
    expect(capability.richness).toBe(3);
  });

  it("tolerates rows without inputs or outputs", () => {
    const catalog = new ToolCapabilityCatalog();
    seedCapabilityCatalog(catalog, [
      ["x.do", "Do a thing", "cat", CAPABILITY_ACCESS.Read, ["tool-a"]],
    ]);
    expect(catalog.require("x.do").inputs).toEqual([]);
  });

  it("defaults an unparsed type to string", () => {
    const catalog = new ToolCapabilityCatalog();
    seedCapabilityCatalog(catalog, [
      ["x.do", "Do a thing", "cat", CAPABILITY_ACCESS.Read, ["tool-a"], "channel"],
    ]);
    expect(catalog.require("x.do").inputs).toEqual([{ name: "channel", type: "string" }]);
  });

  it("parses an outputs list", () => {
    const catalog = new ToolCapabilityCatalog();
    seedCapabilityCatalog(catalog, [
      ["x.do", "Do a thing", "cat", CAPABILITY_ACCESS.Read, ["tool-a"], "a:int", "id, title"],
    ]);
    expect(catalog.require("x.do").outputs).toEqual(["id", "title"]);
  });

  it("seeds the built-in capability set", () => {
    expect(BUILTIN_CAPABILITY_ROWS.length).toBeGreaterThanOrEqual(30);
    const catalog = createBuiltinCapabilityCatalog();
    expect(catalog.size).toBe(BUILTIN_CAPABILITY_ROWS.length);
    // Every built-in capability is satisfiable by at least one provider.
    for (const row of BUILTIN_CAPABILITY_ROWS) {
      expect(row[4].length).toBeGreaterThan(0);
    }
    expect(catalog.stats().categories).toBeGreaterThan(10);
  });

  it("gives every built-in capability an intent phrased as an instruction", () => {
    for (const row of BUILTIN_CAPABILITY_ROWS) {
      const intent: string = row[1];
      expect(intent.length).toBeGreaterThan(0);
      expect(intent.endsWith(".")).toBe(false);
    }
  });
});
