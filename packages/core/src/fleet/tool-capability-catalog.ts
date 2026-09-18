/**
 * Tool capability catalog for the Universal Tool Mesh.
 *
 * Absorbs the discovery-and-ranking layer of three lineages:
 *
 *  - the AnyTool lineage's `ToolRanker` — semantic / keyword / hybrid search modes with a
 *    persistent cache, whose modes become {@link CapabilitySearchMode};
 *  - the OpenHands `extensions` lineage's generated `SKILLS_CATALOG` — a name, a
 *    description, `triggers`, and a `category`, auto-generated from frontmatter, which
 *    becomes the catalog's seed shape;
 *  - the CLI-Anything lineage's `matrix_registry.json` — a capability is declared as an
 *    `id` + `intent` + typed `inputs`/`outputs`, with `recipes` and `known_gaps`.
 *
 * A *capability* is an intent the mesh can satisfy: "send a message", "list issues",
 * "create a calendar event". It is the unit an agent asks for; the tool that satisfies it
 * is looked up second. Separating the two is what lets a provider be swapped without
 * changing what an agent asks for.
 *
 * The semantic mode here is deliberately a lexical-plus-embedding-free ranker: the
 * harness ships no model dependency at this layer, and a deterministic scorer keeps
 * capability resolution reproducible and testable. The seam for a real embedder is
 * {@link CapabilityRanker}.
 *
 * Node built-ins only.
 */
export const CAPABILITY_ACCESS = {
  Read: "read",
  Write: "write",
} as const;
export type CapabilityAccess = (typeof CAPABILITY_ACCESS)[keyof typeof CAPABILITY_ACCESS];

export const CAPABILITY_SEARCH_MODE = {
  Keyword: "keyword",
  Semantic: "semantic",
  Hybrid: "hybrid",
} as const;
export type CapabilitySearchMode =
  (typeof CAPABILITY_SEARCH_MODE)[keyof typeof CAPABILITY_SEARCH_MODE];

export interface CapabilityInput {
  readonly name: string;
  readonly type: string;
  readonly required?: boolean;
  readonly help?: string;
}

export interface Capability {
  /** Stable id, e.g. `message.send`. */
  readonly id: string;
  /** Human intent, phrased as an instruction: "Send a message to a channel". */
  readonly intent: string;
  readonly category: string;
  readonly access: CapabilityAccess;
  readonly inputs: readonly CapabilityInput[];
  /** Output field names a caller can project onto. */
  readonly outputs?: readonly string[];
  /** Trigger phrases, from the extensions lineage's `triggers` field. */
  readonly triggers?: readonly string[];
  /**
   * The providers that can satisfy this capability: preset ids ("linear", "slack") for the
   * built-in catalog, or concrete mesh tool ids for a caller-seeded one. The mesh registry
   * joins either form to the tools it has registered.
   */
  readonly tools: readonly string[];
  /** Known limitations worth surfacing to an agent before it picks this capability. */
  readonly knownGaps?: readonly string[];
  /** Higher is more capable. Used only to break search ties. */
  readonly richness?: number;
}

/** A pluggable ranker; the default is lexical, a caller can supply an embedding-based one. */
export interface CapabilityRanker {
  rank(capability: Capability, query: string): number;
}

export class CapabilityCatalogError extends Error {
  constructor(
    readonly code: "duplicate_capability" | "unknown_capability" | "unknown_tool",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CapabilityCatalogError";
  }
}

/**
 * Splits text into scoring tokens: camelCase and dotted ids become words, punctuation and
 * case fold away, and stop words drop so they cannot dominate a short query.
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "for",
  "with",
  "on",
  "by",
  "that",
  "this",
  "get",
  "create",
  "list",
  "use",
  "into",
  "from",
  "it",
  "is",
  "are",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

/** Ids like `message.send` and names like `sendMessage` tokenize into the same words. */
export function idTokens(id: string): string[] {
  return id
    .toLowerCase()
    .split(/[._\-/]+/)
    .filter((token) => token.length > 0);
}

/** Normalizes a query and a capability into comparable token multisets. */
function matchTokens(
  capability: Capability,
  query: string,
): {
  queryTokens: string[];
  capabilityTokens: string[];
} {
  const queryTokens = tokenize(query);
  const pool = new Set<string>([
    ...tokenize(capability.intent),
    ...idTokens(capability.id),
    ...tokenize(capability.category),
    ...(capability.triggers ?? []).flatMap(tokenize),
    ...capability.inputs.map((input) => input.name.toLowerCase()),
  ]);
  return { queryTokens, capabilityTokens: [...pool] };
}

/** Keyword score: the fraction of query tokens present in the capability's vocabulary. */
export function keywordScore(capability: Capability, query: string): number {
  const { queryTokens, capabilityTokens } = matchTokens(capability, query);
  if (queryTokens.length === 0) return 0;
  const pool = new Set(capabilityTokens);
  const hits = queryTokens.filter((token) => pool.has(token)).length;
  return hits / queryTokens.length;
}

/**
 * Semantic-lite score: ordered subsequence coverage plus a bonus when query tokens appear
 * in the same order as the capability's intent. It approximates "means the same thing"
 * well enough to rank, without a model and without nondeterminism.
 */
export function semanticScore(capability: Capability, query: string): number {
  const { queryTokens } = matchTokens(capability, query);
  if (queryTokens.length === 0) return 0;
  const hay = [
    ...tokenize(capability.intent),
    ...idTokens(capability.id),
    ...(capability.triggers ?? []).flatMap(tokenize),
  ];
  let cursor = 0;
  let matched = 0;
  for (const token of queryTokens) {
    const found = hay.indexOf(token, cursor);
    if (found !== -1) {
      cursor = found + 1;
      matched++;
    }
  }
  const coverage = matched / queryTokens.length;
  const inOrder = matched === queryTokens.length ? 0.25 : 0;
  return Math.min(1, coverage + inOrder);
}

/** Default hybrid ranker: keyword carries the signal, semantic orders the ties. */
export const HYBRID_RANKER: CapabilityRanker = {
  rank: (capability, query) =>
    keywordScore(capability, query) * 0.65 + semanticScore(capability, query) * 0.35,
};

export const KEYWORD_RANKER: CapabilityRanker = {
  rank: (capability, query) => keywordScore(capability, query),
};

export const SEMANTIC_RANKER: CapabilityRanker = {
  rank: (capability, query) => semanticScore(capability, query),
};

export interface CatalogStats {
  capabilities: number;
  categories: number;
  tools: number;
}

/**
 * The catalog of capabilities the mesh knows about. Capabilities are registered with the
 * tool ids that satisfy them, so resolution is a join in one direction and a lookup in
 * the other.
 */
export class ToolCapabilityCatalog {
  private readonly capabilities = new Map<string, Capability>();
  private readonly byTool = new Map<string, Set<string>>();
  private readonly byCategory = new Map<string, Capability[]>();
  private readonly listeners = new Set<(capability: Capability) => void>();

  /** Fires for every registered capability; useful for building a mesh UI. */
  onCapability(listener: (capability: Capability) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Registers a capability; a duplicate id is refused, not overwritten. */
  register(capability: Capability): Capability {
    if (this.capabilities.has(capability.id)) {
      throw new CapabilityCatalogError(
        "duplicate_capability",
        `Capability '${capability.id}' is already registered`,
      );
    }
    if (!capability.id || !capability.intent) {
      throw new CapabilityCatalogError(
        "unknown_capability",
        "A capability requires an id and an intent",
      );
    }
    this.capabilities.set(capability.id, capability);
    for (const tool of capability.tools) {
      let set = this.byTool.get(tool);
      if (set === undefined) {
        set = new Set();
        this.byTool.set(tool, set);
      }
      set.add(capability.id);
    }
    const bucket = this.byCategory.get(capability.category);
    if (bucket === undefined) this.byCategory.set(capability.category, [capability]);
    else bucket.push(capability);
    for (const listener of this.listeners) {
      try {
        listener(capability);
      } catch {
        // a subscriber must not break registration
      }
    }
    return capability;
  }

  get(id: string): Capability | undefined {
    return this.capabilities.get(id);
  }

  /** Requires a capability, throwing when unknown. */
  require(id: string): Capability {
    const capability = this.capabilities.get(id);
    if (capability === undefined) {
      throw new CapabilityCatalogError("unknown_capability", `No capability registered as '${id}'`);
    }
    return capability;
  }

  /** Capabilities satisfiable by a specific tool id. */
  capabilitiesForTool(toolId: string): readonly Capability[] {
    const ids = this.byTool.get(toolId);
    if (ids === undefined) return [];
    return [...ids]
      .map((id) => this.capabilities.get(id))
      .filter((capability): capability is Capability => capability !== undefined);
  }

  /** Every capability in a category. */
  capabilitiesByCategory(category: string): readonly Capability[] {
    return this.byCategory.get(category) ?? [];
  }

  get size(): number {
    return this.capabilities.size;
  }

  get toolCount(): number {
    return this.byTool.size;
  }

  stats(): CatalogStats {
    return {
      capabilities: this.capabilities.size,
      categories: this.byCategory.size,
      tools: this.byTool.size,
    };
  }

  /**
   * Searches capabilities. Keyword mode is exact-token coverage; semantic mode is ordered
   * subsequence; hybrid blends them. Scores below `minScore` are dropped, so a query that
   * matches nothing returns nothing instead of an arbitrary top-N.
   */
  search(
    query: string,
    options: {
      mode?: CapabilitySearchMode;
      limit?: number;
      minScore?: number;
      access?: CapabilityAccess;
    } = {},
  ): ReadonlyArray<Capability & { score: number }> {
    const mode = options.mode ?? CAPABILITY_SEARCH_MODE.Hybrid;
    const ranker =
      mode === CAPABILITY_SEARCH_MODE.Keyword
        ? KEYWORD_RANKER
        : mode === CAPABILITY_SEARCH_MODE.Semantic
          ? SEMANTIC_RANKER
          : HYBRID_RANKER;
    const limit = options.limit ?? 10;
    const minScore = options.minScore ?? 0.15;

    const scored: Array<Capability & { score: number }> = [];
    for (const capability of this.capabilities.values()) {
      if (options.access !== undefined && capability.access !== options.access) continue;
      const score = ranker.rank(capability, query);
      if (score >= minScore) scored.push({ ...capability, score });
    }
    return scored
      .sort(
        (a, b) =>
          b.score - a.score || (b.richness ?? 0) - (a.richness ?? 0) || a.id.localeCompare(b.id),
      )
      .slice(0, limit);
  }

  /**
   * Resolves a natural-language request to the tools that can satisfy it. This is the
   * seam an agent calls: it asks for an intent and gets back tool ids ranked by fit.
   */
  resolveTools(
    query: string,
    options: { mode?: CapabilitySearchMode; limit?: number } = {},
  ): ReadonlyArray<{ toolId: string; score: number; capabilityId: string }> {
    const hits = this.search(query, {
      mode: options.mode,
      limit: options.limit ?? 10,
      minScore: 0.1,
    });
    const out: Array<{ toolId: string; score: number; capabilityId: string }> = [];
    for (const hit of hits) {
      for (const toolId of hit.tools) {
        out.push({ toolId, score: hit.score, capabilityId: hit.id });
      }
    }
    return out
      .sort((a, b) => b.score - a.score || a.toolId.localeCompare(b.toolId))
      .slice(0, options.limit ?? 10);
  }

  /** Removes a capability and its tool index entries. */
  remove(id: string): boolean {
    const capability = this.capabilities.get(id);
    if (capability === undefined) return false;
    this.capabilities.delete(id);
    for (const tool of capability.tools) {
      const set = this.byTool.get(tool);
      if (set === undefined) continue;
      set.delete(id);
      // Drop the tool's index entry once no capability references it, so `toolCount`
      // reflects tools the catalog actually covers instead of growing without bound.
      if (set.size === 0) this.byTool.delete(tool);
    }
    const bucket = this.byCategory.get(capability.category);
    if (bucket !== undefined) {
      const index = bucket.indexOf(capability);
      if (index !== -1) bucket.splice(index, 1);
      if (bucket.length === 0) this.byCategory.delete(capability.category);
    }
    return true;
  }
}

/**
 * Seeds a catalog from a generated capability table — the pattern the extensions lineage
 * uses for its `SKILLS_CATALOG`. Rows are `[id, intent, category, access, tools, inputs]`
 * with `inputs` as a compact `name:type!` string list (`!` marks required).
 */
export function seedCapabilityCatalog(
  catalog: ToolCapabilityCatalog,
  rows: readonly [
    id: string,
    intent: string,
    category: string,
    access: CapabilityAccess,
    tools: readonly string[],
    inputs?: string,
    outputs?: string,
  ][],
): number {
  let count = 0;
  for (const [id, intent, category, access, tools, inputs, outputs] of rows) {
    const parsedInputs: CapabilityInput[] = (inputs ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => {
        const required = part.endsWith("!");
        const body = required ? part.slice(0, -1) : part;
        const [name, type] = body.split(":");
        return {
          name: name ?? body,
          type: type ?? "string",
          ...(required ? { required: true } : {}),
        };
      });
    const parsedOutputs = (outputs ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    catalog.register({
      id,
      intent,
      category,
      access,
      tools,
      inputs: parsedInputs,
      ...(parsedOutputs.length > 0 ? { outputs: parsedOutputs } : {}),
      richness: tools.length + parsedInputs.length,
    });
    count++;
  }
  return count;
}

/**
 * The mesh's built-in capability set: the cross-provider intents every supported SaaS
 * family exposes. Each one is satisfiable by at least one provider preset, so an agent
 * asking for "send a message" resolves to a real tool rather than a placeholder.
 */
export const BUILTIN_CAPABILITY_ROWS: readonly [
  id: string,
  intent: string,
  category: string,
  access: CapabilityAccess,
  tools: readonly string[],
  inputs?: string,
  outputs?: string,
][] = [
  [
    "message.send",
    "Send a message to a channel or conversation",
    "team chat",
    CAPABILITY_ACCESS.Write,
    ["slack", "discord", "telegram", "whatsapp"],
    "channel:text!, body:text!",
  ],
  [
    "message.read",
    "List recent messages in a channel or conversation",
    "team chat",
    CAPABILITY_ACCESS.Read,
    ["slack", "discord", "telegram"],
    "channel:text, limit:int",
  ],
  [
    "issue.create",
    "Create an issue or ticket in a tracker",
    "project management",
    CAPABILITY_ACCESS.Write,
    ["linear", "jira", "github", "gitlab", "trello", "asana"],
    "title:text!, description:text, assignee:text",
  ],
  [
    "issue.list",
    "List issues or tickets in a tracker",
    "project management",
    CAPABILITY_ACCESS.Read,
    ["linear", "jira", "github", "gitlab", "trello", "asana"],
    "project:text, state:text, limit:int",
  ],
  [
    "issue.update",
    "Update an issue's state, assignee, or fields",
    "project management",
    CAPABILITY_ACCESS.Write,
    ["linear", "jira", "github", "gitlab", "asana"],
    "id:text!, state:text, assignee:text",
  ],
  [
    "email.send",
    "Send an email on behalf of a mailbox",
    "email",
    CAPABILITY_ACCESS.Write,
    ["gmail", "outlook", "sendgrid"],
    "to:text!, subject:text!, body:text!",
  ],
  [
    "email.search",
    "Search a mailbox for messages",
    "email",
    CAPABILITY_ACCESS.Read,
    ["gmail", "outlook"],
    "query:text!, limit:int",
  ],
  [
    "calendar.create",
    "Create a calendar event",
    "scheduling & booking",
    CAPABILITY_ACCESS.Write,
    ["googlecalendar", "cal", "calendly"],
    "title:text!, start:text!, end:text!",
  ],
  [
    "calendar.list",
    "List calendar events in a window",
    "scheduling & booking",
    CAPABILITY_ACCESS.Read,
    ["googlecalendar", "cal", "outlook"],
    "from:text, to:text, limit:int",
  ],
  [
    "contact.list",
    "List contacts in a CRM or address book",
    "crm",
    CAPABILITY_ACCESS.Read,
    ["hubspot", "salesforce", "pipedrive", "zoho", "googlecontacts"],
    "limit:int",
  ],
  [
    "contact.create",
    "Create a contact in a CRM",
    "crm",
    CAPABILITY_ACCESS.Write,
    ["hubspot", "salesforce", "pipedrive", "zoho"],
    "name:text!, email:text",
  ],
  [
    "deal.list",
    "List deals or opportunities",
    "crm",
    CAPABILITY_ACCESS.Read,
    ["hubspot", "salesforce", "pipedrive"],
    "limit:int",
  ],
  [
    "file.upload",
    "Upload a file to a storage provider",
    "file management & storage",
    CAPABILITY_ACCESS.Write,
    ["googledrive", "dropbox", "s3", "onedrive"],
    "path:text!, content:text!",
  ],
  [
    "file.download",
    "Download a file from a storage provider",
    "file management & storage",
    CAPABILITY_ACCESS.Read,
    ["googledrive", "dropbox", "s3", "onedrive"],
    "path:text!",
  ],
  [
    "file.list",
    "List files in a folder",
    "file management & storage",
    CAPABILITY_ACCESS.Read,
    ["googledrive", "dropbox", "s3", "onedrive"],
    "folder:text, limit:int",
  ],
  [
    "sheet.read",
    "Read rows from a spreadsheet",
    "spreadsheets",
    CAPABILITY_ACCESS.Read,
    ["googlesheets", "airtable", "notion"],
    "sheet:text!, range:text",
  ],
  [
    "sheet.write",
    "Append or update rows in a spreadsheet",
    "spreadsheets",
    CAPABILITY_ACCESS.Write,
    ["googlesheets", "airtable", "notion"],
    "sheet:text!, rows:text!",
  ],
  [
    "doc.create",
    "Create a document or page",
    "documents",
    CAPABILITY_ACCESS.Write,
    ["googledocs", "notion", "confluence"],
    "title:text!, body:text",
  ],
  [
    "repo.list",
    "List repositories for the authenticated owner",
    "software development",
    CAPABILITY_ACCESS.Read,
    ["github", "gitlab", "bitbucket"],
    "limit:int",
  ],
  [
    "repo.create",
    "Create a repository",
    "software development",
    CAPABILITY_ACCESS.Write,
    ["github", "gitlab", "bitbucket"],
    "name:text!, private:bool",
  ],
  [
    "pull_request.open",
    "Open a pull request",
    "software development",
    CAPABILITY_ACCESS.Write,
    ["github", "gitlab", "bitbucket"],
    "repo:text!, title:text!, body:text",
  ],
  [
    "pull_request.list",
    "List open pull requests",
    "software development",
    CAPABILITY_ACCESS.Read,
    ["github", "gitlab", "bitbucket"],
    "repo:text!, limit:int",
  ],
  [
    "payment.create",
    "Create a payment or charge",
    "payment processing",
    CAPABILITY_ACCESS.Write,
    ["stripe", "paypal", "razorpay"],
    "amount:float!, currency:text!, customer:text",
  ],
  [
    "payment.list",
    "List payments or charges",
    "payment processing",
    CAPABILITY_ACCESS.Read,
    ["stripe", "paypal", "razorpay"],
    "limit:int",
  ],
  [
    "task.create",
    "Create a task in a to-do or project tool",
    "task management",
    CAPABILITY_ACCESS.Write,
    ["todoist", "asana", "clickup", "trello"],
    "title:text!, due:text",
  ],
  [
    "task.list",
    "List tasks",
    "task management",
    CAPABILITY_ACCESS.Read,
    ["todoist", "asana", "clickup", "trello"],
    "limit:int",
  ],
  [
    "form.list",
    "List forms or surveys",
    "forms",
    CAPABILITY_ACCESS.Read,
    ["typeform", "googleforms", "formsite"],
    "limit:int",
  ],
  [
    "analytics.report",
    "Fetch an analytics report or metric series",
    "analytics",
    CAPABILITY_ACCESS.Read,
    ["googleanalytics", "mixpanel", "amplitude"],
    "metric:text!, from:text, to:text",
  ],
  [
    "image.generate",
    "Generate an image from a prompt",
    "images & design",
    CAPABILITY_ACCESS.Write,
    ["openai", "stability", "midjourney"],
    "prompt:text!, size:text",
  ],
  [
    "video.generate",
    "Generate a video from a prompt",
    "video & audio",
    CAPABILITY_ACCESS.Write,
    ["veo", "runway", "luma"],
    "prompt:text!, duration:int",
  ],
  [
    "storage.object.get",
    "Fetch an object from an object store",
    "databases",
    CAPABILITY_ACCESS.Read,
    ["s3", "supabase", "cloudflare"],
    "bucket:text!, key:text!",
  ],
  [
    "query.sql",
    "Run a SQL query against a warehouse",
    "databases",
    CAPABILITY_ACCESS.Read,
    ["googlebigquery", "snowflake", "supabase", "postgres"],
    "sql:text!, limit:int",
  ],
];

/** A catalog pre-seeded with the built-in capability set. */
export function createBuiltinCapabilityCatalog(): ToolCapabilityCatalog {
  const catalog = new ToolCapabilityCatalog();
  seedCapabilityCatalog(catalog, BUILTIN_CAPABILITY_ROWS);
  return catalog;
}
