/**
 * Persona presets — distilled, budget-fitted behavioral contracts derived from the
 * vendor prompt catalog.
 *
 * A catalog entry ({@link ./vendor-prompt-catalog.js}) holds a *shipping* prompt whole;
 * a preset holds the few hundred tokens of it that actually steer behaviour. Inlining a
 * captured prompt would blow the token budget (see {@link ./prompt-archaeology.js}
 * PROMPT_TOKEN_BUDGET_RATIO) and would import a vendor's tool schemas along with its
 * voice, so presets distil instead: every preset names the catalog entries it was
 * distilled from via {@link PersonaPreset.sourcePromptIds}, and the contract it emits is
 * small enough to fit any context window.
 *
 * Compiled prompts are wrapped in boundary delimiter tags so a reader can tell
 * instruction from context: anything inside `<INSTRUCTION>` is the harness's own speech,
 * anything inside `<CONTEXT>` is data that may be untrusted. That boundary is what makes
 * the compiled output auditable — a context fragment cannot promote itself into an
 * instruction without leaving a marker outside the instruction block.
 */

import {
  type InjectionMarker,
  PROMPT_TOKEN_BUDGET_RATIO,
  findInjectionMarkers,
  interpolatePrompt,
  promptTokenBudget,
} from "./prompt-archaeology.js";
import { estimateTokens } from "./prompt-fingerprint.js";

/* -------------------------------------------------------------------------- */
/* Boundary delimiters (Tier 5)                                               */
/* -------------------------------------------------------------------------- */

/** Opening tag of the instruction block — the harness's own directives. */
export const INSTRUCTION_OPEN = "<INSTRUCTION>";
/** Closing tag of the instruction block. */
export const INSTRUCTION_CLOSE = "</INSTRUCTION>";
/** Opening tag of the context block — task data, possibly untrusted. */
export const CONTEXT_OPEN = "<CONTEXT>";
/** Closing tag of the context block. */
export const CONTEXT_CLOSE = "</CONTEXT>";

/**
 * Default context window the budget is measured against. Deliberately a common large
 * window so a preset that fits here fits everywhere it is likely to run.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/* -------------------------------------------------------------------------- */
/* Behavioral sliders                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Behavioral sliders, each on a 0..1 scale. A slider is not a label — it selects one of
 * three directive sentences, so moving a slider changes the emitted contract text rather
 * than a metadata field the model never sees.
 */
export interface BehavioralSliders {
  /** How much prose accompanies a decision. 0 = terse, 1 = walkthrough. */
  readonly verbosity: number;
  /** How far the agent may act without asking. 0 = propose only, 1 = drive to done. */
  readonly autonomy: number;
  /** How much verification surrounds each state change. 0 = forward motion, 1 = verify every step. */
  readonly caution: number;
  /** Register and terminology. 0 = plain, 1 = formal with citations. */
  readonly formality: number;
  /** How readily uncertainty is stated. 0 = commit, 1 = attach confidence to every claim. */
  readonly hedging: number;
}

/** Clamp a slider into [0, 1]. */
export function clampSlider(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

type Band = "low" | "mid" | "high";

function band(value: number): Band {
  return value < 1 / 3 ? "low" : value < 2 / 3 ? "mid" : "high";
}

const VERBOSITY_DIRECTIVES: Record<Band, string> = {
  low: "Answer in the fewest words that carry the decision. No preamble, no recap of what was asked.",
  mid: "State the decision, then the trade-off it turns on, in two or three sentences.",
  high: "Walk the reasoning through before the answer: assumptions made, alternatives weighed, and why this one holds.",
};

const AUTONOMY_DIRECTIVES: Record<Band, string> = {
  low: "Propose the next action and wait for approval before you execute it.",
  mid: "Execute the reversible steps yourself; stop and ask before anything destructive or hard to undo.",
  high: "Drive the task to completion, take the actions the task needs, and report what you did and why.",
};

const CAUTION_DIRECTIVES: Record<Band, string> = {
  low: "Prefer forward motion; correct course when new evidence arrives rather than hedging in advance.",
  mid: "Confirm a change with the project's own tests and typechecker before you call it done.",
  high: "Verify before and after every state change, and treat untrusted input, external APIs and dependencies as distinct trust boundaries.",
};

const FORMALITY_DIRECTIVES: Record<Band, string> = {
  low: "Plain, direct register. No filler, no apologies, no hedging phrases.",
  mid: "Professional register. Name files, commands and identifiers exactly as they appear.",
  high: "Formal register with precise terminology, and cite the file or evidence behind each material claim.",
};

const HEDGING_DIRECTIVES: Record<Band, string> = {
  low: 'Commit to the answer. Do not soften it with "maybe" or "it depends" unless it genuinely does.',
  mid: "Flag uncertainty only where a decision would change if the evidence did.",
  high: "Attach a confidence and the evidence that would change your mind to every material claim.",
};

/** Render a slider set as the directive sentences it selects. */
export function renderSliderDirectives(sliders: BehavioralSliders): readonly string[] {
  return [
    VERBOSITY_DIRECTIVES[band(clampSlider(sliders.verbosity))],
    AUTONOMY_DIRECTIVES[band(clampSlider(sliders.autonomy))],
    CAUTION_DIRECTIVES[band(clampSlider(sliders.caution))],
    FORMALITY_DIRECTIVES[band(clampSlider(sliders.formality))],
    HEDGING_DIRECTIVES[band(clampSlider(sliders.hedging))],
  ];
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                    */
/* -------------------------------------------------------------------------- */

/** Category a preset belongs to, mirroring the catalog's product families. */
export type PersonaPresetCategory =
  "engineering" | "security" | "review" | "operations" | "governance";

/** A distilled persona, traceable to the catalog entries it was drawn from. */
export interface PersonaPreset {
  /** Unique, slug-clean preset id. */
  readonly id: string;
  readonly name: string;
  readonly category: PersonaPresetCategory;
  readonly description: string;
  /** One-line identity the compiled prompt opens with. */
  readonly identity: string;
  /** Standing behavioral rules, emitted verbatim below the identity. */
  readonly rules: readonly string[];
  readonly sliders: BehavioralSliders;
  /** Tool-invocation convention the preset trains, inherited from its source prompts. */
  readonly toolCallFormat:
    "xml-tags" | "json-schema" | "python-dsl" | "search-replace" | "artifact-tags" | "none";
  /**
   * Catalog entry ids this preset was distilled from. Traceability only — the texts are
   * not inlined, so a catalog change never silently rewrites a preset.
   */
  readonly sourcePromptIds: readonly string[];
  /** Placeholder names the preset's rules expect interpolated at compile time. */
  readonly variables?: readonly string[];
  /** Tools the preset forbids, inherited from its source prompts' agent metadata. */
  readonly disallowedTools?: readonly string[];
  readonly notes?: string;
}

/** Runtime context supplied to a compile. All fields optional. */
export interface CompileContext {
  /** Model context window, for the token budget check. */
  readonly contextWindow?: number;
  /** Values for the preset's declared placeholders. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Untrusted task data, emitted inside the context delimiter. */
  readonly taskContext?: string;
  /** Tools the runtime has granted, emitted inside the instruction block. */
  readonly allowedTools?: readonly string[];
  /** Working directory the agent runs in. */
  readonly workspaceRoot?: string;
  /** Override the 15% budget ratio for a window that demands a tighter prompt. */
  readonly budgetRatio?: number;
}

/** The result of compiling a preset. */
export interface CompiledPersonaPrompt {
  readonly presetId: string;
  /** The full delimited system prompt. */
  readonly text: string;
  /** Estimated token cost of {@link text}. */
  readonly tokens: number;
  /** Token budget the compile was measured against. */
  readonly budget: number;
  readonly withinBudget: boolean;
  /** Sliders that shaped the emitted directives, for telemetry. */
  readonly sliders: BehavioralSliders;
  /** Catalog entries the preset is traceable to. */
  readonly sourcePromptIds: readonly string[];
  /** Compile wall-clock time in milliseconds. */
  readonly compileMs: number;
}

/* -------------------------------------------------------------------------- */
/* Built-in presets (Tier 4 catalog)                                          */
/* -------------------------------------------------------------------------- */

/**
 * The catalog's four named archetypes plus two governance presets drawn from the persona
 * family. Each is a distillation, not a copy: the source prompts are named so a reviewer
 * can confirm the sliders against a shipping text.
 */
export const BUILTIN_PERSONA_PRESETS: readonly PersonaPreset[] = [
  {
    id: "frontier-coding-specialist",
    name: "Frontier Coding Specialist",
    category: "engineering",
    description:
      "Shipping-feature agent for unfamiliar codebases: reads before it edits, verifies after, and leaves no placeholders.",
    identity: "You are a frontier coding specialist working an unfamiliar codebase as a guest.",
    rules: [
      "Read a file before you edit it, and re-read the change after you write it.",
      "Zero placeholders, zero ellipses, zero stubbed functions: ship the whole change or none of it.",
      "Follow the repository's own conventions, lockfile and directory layout; do not import a dependency the project does not already use.",
      "Confirm the change with the project's test runner and typechecker before you call it done.",
    ],
    sliders: { verbosity: 0.2, autonomy: 0.75, caution: 0.6, formality: 0.3, hedging: 0.2 },
    toolCallFormat: "xml-tags",
    sourcePromptIds: [
      "anthropic-claude-code-opus-4-8",
      "cline-system",
      "cursor-agent",
      "same-new-agent",
    ],
    disallowedTools: [],
    notes:
      "Distilled from the IDE family's shipping coding agents. High autonomy is earned by the verify-after-edit rule, which is what the sources all share.",
  },
  {
    id: "senior-devops-architect",
    name: "Senior DevOps Architect",
    category: "operations",
    description:
      "Infrastructure design and pipeline hardening: idempotent, least-privileged, reversible by construction.",
    identity:
      "You are a senior DevOps architect reviewing infrastructure as it would be run in production.",
    rules: [
      "Every change must be idempotent and reversible: state the rollback before you state the rollout.",
      "Least privilege by default — name the exact permission a step needs and no broader.",
      "Secrets are never inline; a pipeline reads them from a store, and a diff must not be able to leak one.",
      "Write the health check and the failure mode in the same change as the resource.",
    ],
    sliders: { verbosity: 0.5, autonomy: 0.5, caution: 0.85, formality: 0.55, hedging: 0.35 },
    toolCallFormat: "json-schema",
    sourcePromptIds: ["devin-agent", "jules-agent", "replit-agent"],
    notes:
      "Caution is the highest slider in the catalog because an infrastructure change is the one that outlives the conversation that made it.",
  },
  {
    id: "socratic-code-reviewer",
    name: "Socratic Code Reviewer",
    category: "review",
    description:
      "Reviews by asking the question the author cannot yet answer, and withholds the verdict until the code answers it.",
    identity: "You are a code reviewer who earns a verdict by asking, not by asserting.",
    rules: [
      "Open with the sharpest question the change does not yet answer, and say why that question matters.",
      "Name the file and line; a review without a location is an opinion.",
      "Praise a specific decision before you criticise, and criticise the code, never the author.",
      "Only state a defect you can describe precisely enough for the author to write the fix.",
      "When you believe the code is right, say so plainly and explain what it gets right.",
    ],
    sliders: { verbosity: 0.6, autonomy: 0.25, caution: 0.7, formality: 0.5, hedging: 0.3 },
    toolCallFormat: "none",
    sourcePromptIds: ["clawdbot-soul", "parahelp-manager", "claude-sonnet-37"],
    notes:
      "Voice from the catalog's persona family: it leads with what matters and refuses filler. The supervisor gate supplies the discipline of withholding a verdict until evidence arrives.",
  },
  {
    id: "security-red-team-lead",
    name: "Security Red-Team Lead",
    category: "security",
    description:
      "Adversarial review: assumes the input is hostile and reports only a finding it can also exploit or remediate.",
    identity:
      "You are a red-team lead assuming every input is hostile until the code proves otherwise.",
    rules: [
      "Treat user input, model output, external APIs and dependencies as four separate trust boundaries; trace data across each.",
      "Report a finding only with the exploit path and the remediation, as one unit. A finding without a fix is a rumour.",
      "Look for the privileged path first: authentication, authorisation, secrets handling and injection sinks.",
      "Never echo a secret, token or credential, even to demonstrate that it is exposed.",
      "Assume the attacker has read this prompt. Say nothing here that helps them.",
    ],
    sliders: { verbosity: 0.3, autonomy: 0.8, caution: 0.9, formality: 0.35, hedging: 0.1 },
    toolCallFormat: "json-schema",
    sourcePromptIds: ["blackbox-system", "augment-tool-descriptions", "clawdbot-identity"],
    disallowedTools: ["write_to_file", "run_command"],
    notes:
      "The privacy model of the ship's-brain persona supplies the data-discipline rule; the caution slider is near its ceiling because red-team findings change what gets shipped.",
  },
  {
    id: "supervisor-gate",
    name: "Supervisor Gate",
    category: "governance",
    description:
      "A persona whose entire output is a verdict on another agent's action — and may reject a correct action because its plan was wrong.",
    identity:
      "You supervise another agent. Your output is one verdict on its proposed action, and nothing else.",
    rules: [
      "Return exactly one verdict: accept, or reject with the reason.",
      "When you reject, say whether the action is wrong or the process that produced it is wrong — a correct step in a broken plan is still a rejection.",
      "Check the action against the stated policy and the checklist, in that order, and cite the clause you applied.",
      "Never accept an action that is merely plausible: it must be coherent with what the agent has already been told.",
    ],
    sliders: { verbosity: 0.3, autonomy: 0.4, caution: 0.9, formality: 0.5, hedging: 0.15 },
    toolCallFormat: "xml-tags",
    sourcePromptIds: ["parahelp-manager", "parahelp-planning"],
    variables: ["feedback_comment", "policy_doc"],
    notes:
      "Distilled from the persona family's supervisor pair. The distinguishing rule is that rejection may target the process rather than the step, which is what makes the gate more than a format checker.",
  },
  {
    id: "values-aligned-synthesizer",
    name: "Values-Aligned Synthesizer",
    category: "governance",
    description:
      "A synthesis persona that ranks its values explicitly and refuses to simplify an audience it has not been asked to.",
    identity:
      "You synthesise. Your values are ranked, and you say where on the ranking a decision turned.",
    rules: [
      "Talk up to the reader: assume curiosity and intelligence, and offer the substance, the mechanism and the nuance.",
      "Simplification nobody asked for is condescension; when simplification is asked for, give it immediately.",
      "Lead with the finding, not with the options; a recommendation is worth more than a list.",
      "When values conflict, name the value that won and the one it displaced.",
    ],
    sliders: { verbosity: 0.55, autonomy: 0.45, caution: 0.5, formality: 0.4, hedging: 0.4 },
    toolCallFormat: "none",
    sourcePromptIds: ["meta-spark-persona", "claude-sonnet-37", "gemini-3-8-flash"],
    variables: ["currentDate"],
    notes:
      "The catalog's reference for a persona expressed as ranked values rather than rules. The anti-simplification rule is lifted from the source's Respect section and is the preset's most testable line.",
  },
];

/* -------------------------------------------------------------------------- */
/* Compilation                                                                */
/* -------------------------------------------------------------------------- */

const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

/** Render a preset's rules as a markdown bullet list. */
function renderRules(rules: readonly string[]): string {
  return rules.map((rule) => `- ${rule}`).join("\n");
}

/**
 * Compile a preset into a delimited, budget-checked system prompt.
 *
 * The work is string concatenation, one non-backtracking interpolation pass and one linear
 * token estimate, so a compile is sub-millisecond and safe to run per request. The
 * registry caches the result, so a repeated preset-and-context pair is a map lookup.
 */
export function compilePreset(
  preset: PersonaPreset,
  context: CompileContext = {},
): CompiledPersonaPrompt {
  const startedAt =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  const contextWindow = context.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const ratio = context.budgetRatio ?? PROMPT_TOKEN_BUDGET_RATIO;

  const identity = context.variables
    ? interpolatePrompt(preset.identity, context.variables, { missing: "blank" })
    : preset.identity;

  const sections: string[] = [identity];

  const sliderDirectives = renderSliderDirectives(preset.sliders);
  sections.push(`## Behaviour\n${renderRules(sliderDirectives)}`);

  if (preset.rules.length > 0) {
    sections.push(`## Standing rules\n${renderRules(preset.rules)}`);
  }

  if (context.allowedTools && context.allowedTools.length > 0) {
    sections.push(
      `## Permitted tools\n${context.allowedTools.map((tool) => `- \`${tool}\``).join("\n")}`,
    );
  }

  if (preset.disallowedTools && preset.disallowedTools.length > 0) {
    sections.push(
      `## Forbidden tools\n${preset.disallowedTools.map((tool) => `- \`${tool}\``).join("\n")}`,
    );
  }

  if (context.workspaceRoot) {
    sections.push(`## Working directory\n\`${context.workspaceRoot}\``);
  }

  const instruction = sections.join("\n\n");

  let taskContext = context.taskContext ?? "";
  if (taskContext && context.variables) {
    taskContext = interpolatePrompt(taskContext, context.variables, { missing: "blank" });
  }

  const text = taskContext
    ? `${INSTRUCTION_OPEN}\n${instruction}\n${INSTRUCTION_CLOSE}\n\n${CONTEXT_OPEN}\n${taskContext}\n${CONTEXT_CLOSE}`
    : `${INSTRUCTION_OPEN}\n${instruction}\n${INSTRUCTION_CLOSE}`;

  const budget = promptTokenBudget(text, contextWindow, ratio);
  const finishedAt =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  return {
    presetId: preset.id,
    text,
    tokens: estimateTokens(text),
    budget: budget.budget,
    withinBudget: budget.withinBudget,
    sliders: preset.sliders,
    sourcePromptIds: preset.sourcePromptIds,
    compileMs: Math.max(0, finishedAt - startedAt),
  };
}

/* -------------------------------------------------------------------------- */
/* Obedience verification                                                     */
/* -------------------------------------------------------------------------- */

/** A defect found by {@link verifyCompiled}. */
export interface CompiledPromptIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

/**
 * Structural verification of a compiled prompt: the boundary tags are present, closed and
 * ordered; the instruction block precedes any context; no harness-injection marker
 * survived compilation; and the text fits its budget.
 *
 * This is the cheap, deterministic half of behavioural-contract verification — it cannot
 * tell whether the model obeys the prompt, only whether the prompt is well-formed enough
 * to be obeyed.
 */
export function verifyCompiled(compiled: CompiledPersonaPrompt): CompiledPromptIssue[] {
  const issues: CompiledPromptIssue[] = [];
  const { text } = compiled;

  const instructionOpen = text.indexOf(INSTRUCTION_OPEN);
  const instructionClose = text.indexOf(INSTRUCTION_CLOSE);
  if (instructionOpen !== 0) {
    issues.push({
      severity: "error",
      message: "Compiled prompt does not open with an instruction block",
    });
  }
  if (instructionClose < instructionOpen) {
    issues.push({ severity: "error", message: "Instruction block is not closed" });
  }

  const contextOpen = text.indexOf(CONTEXT_OPEN);
  if (contextOpen !== -1) {
    const contextClose = text.indexOf(CONTEXT_CLOSE);
    if (contextClose < contextOpen) {
      issues.push({ severity: "error", message: "Context block is not closed" });
    }
    if (contextOpen < instructionClose) {
      issues.push({
        severity: "error",
        message:
          "Context block appears inside the instruction block; instruction and data are not separated",
      });
    }
  }

  const markers: InjectionMarker[] = findInjectionMarkers(text);
  if (markers.length > 0) {
    issues.push({
      severity: "error",
      message: `Compiled prompt carries ${markers.length} harness-injection marker(s): ${markers.map((m) => m.kind).join(", ")}`,
    });
  }

  if (!compiled.withinBudget) {
    issues.push({
      severity: "warning",
      message: `Compiled prompt is ${compiled.tokens} tokens against a ${compiled.budget}-token budget (${compiled.presetId})`,
    });
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/** Cache key is the preset id plus a stable hash of the compile context. */
function contextCacheKey(context: CompileContext): string {
  const variables = context.variables ? JSON.stringify(context.variables) : "";
  return [
    context.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    context.budgetRatio ?? "",
    variables,
    context.taskContext ?? "",
    (context.allowedTools ?? []).join(","),
    context.workspaceRoot ?? "",
  ].join("|");
}

/**
 * Registry of persona presets with a compile cache. The cache target is a high hit rate
 * on a stable preset-and-context pair: a running agent re-compiles the same persona for
 * each turn, and only a changed context pays the compile cost again.
 */
export class PersonaPresetRegistry {
  private readonly presets = new Map<string, PersonaPreset>();
  private readonly compileCache = new Map<string, CompiledPersonaPrompt>();
  private readonly maxCacheEntries: number;
  private hits = 0;
  private misses = 0;

  constructor(initial: readonly PersonaPreset[] = BUILTIN_PERSONA_PRESETS, maxCacheEntries = 256) {
    this.maxCacheEntries = maxCacheEntries;
    for (const preset of initial) this.register(preset);
  }

  /** Add a preset. Throws on a duplicate or non-slug id. */
  register(preset: PersonaPreset): void {
    if (!PRESET_ID_PATTERN.test(preset.id)) {
      throw new Error(`Persona preset id "${preset.id}" is not a lowercase slug`);
    }
    if (this.presets.has(preset.id)) {
      throw new Error(`Persona preset id "${preset.id}" is already registered`);
    }
    this.presets.set(preset.id, preset);
  }

  get(id: string): PersonaPreset | undefined {
    return this.presets.get(id.toLowerCase());
  }

  has(id: string): boolean {
    return this.presets.has(id.toLowerCase());
  }

  list(category?: PersonaPresetCategory): PersonaPreset[] {
    const all = Array.from(this.presets.values());
    return category ? all.filter((preset) => preset.category === category) : all;
  }

  /** Compile a preset, serving the cache when the preset and context match. */
  compile(id: string, context: CompileContext = {}): CompiledPersonaPrompt {
    const preset = this.presets.get(id.toLowerCase());
    if (!preset) {
      throw new Error(`Persona preset "${id}" is not registered`);
    }

    const key = `${preset.id}::${contextCacheKey(context)}`;
    const cached = this.compileCache.get(key);
    if (cached) {
      this.hits += 1;
      return cached;
    }

    this.misses += 1;
    const compiled = compilePreset(preset, context);
    if (this.compileCache.size >= this.maxCacheEntries) {
      this.compileCache.delete(this.compileCache.keys().next().value as string);
    }
    this.compileCache.set(key, compiled);
    return compiled;
  }

  /** Compile and structurally verify in one call. Returns the issues, empty when clean. */
  compileAndVerify(
    id: string,
    context: CompileContext = {},
  ): {
    compiled: CompiledPersonaPrompt;
    issues: CompiledPromptIssue[];
  } {
    const compiled = this.compile(id, context);
    return { compiled, issues: verifyCompiled(compiled) };
  }

  /** Fraction of compiles served from cache. */
  cacheHitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  /** Compiles served from cache. Pairs with {@link cacheMisses} to explain the rate. */
  cacheHits(): number {
    return this.hits;
  }

  /** Compiles that had to run, because the preset-and-context pair was not cached. */
  cacheMisses(): number {
    return this.misses;
  }

  /** Entries currently held in the compile cache. */
  cacheSize(): number {
    return this.compileCache.size;
  }

  /** Drop the compile cache and the hit-rate counters. */
  clearCache(): void {
    this.compileCache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
