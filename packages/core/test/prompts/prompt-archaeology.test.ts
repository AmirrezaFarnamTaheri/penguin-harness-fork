import { describe, expect, it } from "vitest";

import {
  type PromptRecord,
  assertUniquePromptFilenames,
  categorizePromptName,
  decodeSourceEscapes,
  detectInterpolationStyle,
  detectToolCallFormat,
  extractTemplateLiterals,
  extractVariables,
  findInjectionMarkers,
  interpolatePrompt,
  nameToFilename,
  normalizeMarkdown,
  parsePromptFrontmatter,
  parseYamlString,
  promptTokenBudget,
  reconstructPrompt,
  renderPromptFrontmatter,
  scanTemplateLiterals,
  stripInjectionMarkers,
  yamlString,
} from "../../src/prompts/prompt-archaeology.js";

describe("prompt-archaeology / canonical filenames", () => {
  // Ported from the donor archive's promptMarkdownUtils test suite, which is the
  // reference behaviour for the slug algorithm the catalogued prompts were named with.
  it("nameToFilename applies the documented canonical slug algorithm", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Agent Prompt: CLAUDE.md creation", "agent-prompt-claude-md-creation.md"],
      [
        "Skill: Code Review angle E wrapper/proxy correctness",
        "skill-code-review-angle-e-wrapper-proxy-correctness.md",
      ],
      [
        "Tool Parameter: Bash run_in_background guidance",
        "tool-parameter-bash-run-in-background-guidance.md",
      ],
      ["System Prompt: PowerShell edition for 5.1", "system-prompt-powershell-edition-for-5-1.md"],
      ["Tool Description: Claude.ai project", "tool-description-claude-ai-project.md"],
      ["Data: --- repeated... punctuation ___", "data-repeated-punctuation.md"],
    ];

    for (const [name, expected] of cases) {
      expect(nameToFilename(name)).toBe(expected);
    }
  });

  it("categorizePromptName maps names onto the archive's taxonomy", () => {
    expect(categorizePromptName("Agent Prompt: Explore codebase")).toEqual({
      category: "agent",
      subcategory: "Sub-agents",
    });
    expect(categorizePromptName("Agent Prompt: CLAUDE.md creation helper")).toEqual({
      category: "agent",
      subcategory: "Creation Assistants",
    });
    expect(categorizePromptName("Agent Prompt: my slash command")).toEqual({
      category: "agent",
      subcategory: "Slash commands",
    });
    expect(categorizePromptName("Agent Prompt: status line utility")).toEqual({
      category: "agent",
      subcategory: "Utilities",
    });
    expect(categorizePromptName("Data: wrapper proxy")).toEqual({
      category: "data",
      subcategory: null,
    });
    expect(categorizePromptName("Something else entirely")).toEqual({
      category: "other",
      subcategory: null,
    });
  });

  it("assertUniquePromptFilenames rejects canonical slug collisions", () => {
    expect(() =>
      assertUniquePromptFilenames([
        { name: "Data: wrapper/proxy" },
        { name: "Data: wrapper proxy" },
      ]),
    ).toThrow(/Canonical filename collision for data-wrapper-proxy\.md/);
  });

  it("assertUniquePromptFilenames returns the filename map when names are distinct", () => {
    const map = assertUniquePromptFilenames([{ name: "Skill: one" }, { name: "Data: two" }]);
    expect(map.size).toBe(2);
    expect(map.get("skill-one.md")).toBe("Skill: one");
  });
});

describe("prompt-archaeology / yaml scalars", () => {
  it("parseYamlString reads current and legacy generated name scalars", () => {
    expect(parseYamlString('"Agent Prompt: Example"')).toBe("Agent Prompt: Example");
    expect(parseYamlString("'Agent Prompt: Example'")).toBe("Agent Prompt: Example");
    expect(parseYamlString("'Agent Prompt: It''s quoted'")).toBe("Agent Prompt: It's quoted");
  });

  it("yamlString safely quotes YAML-significant and multiline values", () => {
    const values = [
      "Code-review dimension: check whether...",
      "*",
      "contains # a comment marker",
      "true",
      "null",
      'single and "double" quotes',
      " leading and trailing ",
      "first line\nsecond line",
    ];

    for (const value of values) {
      expect(JSON.parse(yamlString(value))).toBe(value);
    }
    expect(() => yamlString("closes --> the metadata comment")).toThrow(/HTML comment terminator/);
  });
});

describe("prompt-archaeology / source escapes", () => {
  it("decodeSourceEscapes restores escaped source punctuation", () => {
    expect(decodeSourceEscapes("Reply \\`go\\`")).toBe("Reply `go`");
    expect(decodeSourceEscapes('say \\"yes\\"')).toBe('say "yes"');
    expect(decodeSourceEscapes("keep \\n and \\t escapes")).toBe("keep \\n and \\t escapes");
    expect(decodeSourceEscapes("escaped \\\\ slash")).toBe("escaped \\ slash");
  });

  it("reconstructPrompt joins split pieces through their identifier map", () => {
    expect(
      reconstructPrompt({
        pieces: ["You operate in ", " and work on ", "."],
        identifiers: [0, 1],
        identifierMap: { 0: "cwd", 1: "task" },
      }),
    ).toBe("You operate in cwd and work on task.");

    // A single piece is decoded without needing any identifier.
    expect(
      reconstructPrompt({
        pieces: ["Reply \\`go\\`"],
        identifiers: [],
        identifierMap: {},
      }),
    ).toBe("Reply `go`");

    expect(reconstructPrompt({ pieces: [], identifiers: [], identifierMap: {} })).toBe("");
  });
});

describe("prompt-archaeology / frontmatter", () => {
  it("renderPromptFrontmatter quotes every string field and list item", () => {
    const frontmatter = renderPromptFrontmatter({
      name: "Agent Prompt: Example",
      description: "Description: with # YAML syntax\nand a second line",
      version: "2.1.215",
      identifierMap: { 0: "TRUE", 1: "NULL_VALUE" },
      agentMetadata: {
        agentType: "example",
        model: "inherit",
        color: "violet",
        permissionMode: "bubble",
        maxTurns: 200,
        whenToUseDynamic: true,
        tools: ["*", "Read"],
        toolsNote: "Tools: all inherited",
        disallowedTools: ["Agent"],
        whenToUse: "Use when: needed\nAcross lines",
        criticalSystemReminder: "Do not treat # as a comment",
      },
    });

    expect(frontmatter).toMatch(/^<!--\n/);
    expect(frontmatter).toMatch(
      /description: "Description: with # YAML syntax\\nand a second line"/,
    );
    expect(frontmatter).toMatch(/ccVersion: "2\.1\.215"/);
    expect(frontmatter).toMatch(/    - "\*"/);
    expect(frontmatter).toMatch(/  whenToUse: "Use when: needed\\nAcross lines"/);
    expect(frontmatter).toMatch(/\n-->\n$/);
  });

  it("renderPromptFrontmatter preserves scalar tool metadata", () => {
    const frontmatter = renderPromptFrontmatter({
      name: "Agent Prompt: Legacy example",
      description: "Legacy scalar metadata",
      version: "2.1.216",
      agentMetadata: { tools: "*", disallowedTools: "Agent" },
    });

    expect(frontmatter).toMatch(/\n  tools: "\*"\n/);
    expect(frontmatter).toMatch(/\n  disallowedTools: "Agent"\n/);
  });

  it("round-trips a rendered record through parsePromptFrontmatter", () => {
    const record: PromptRecord = {
      name: "Agent Prompt: Round trip",
      description: "Description: with # YAML syntax\nand a second line",
      version: "2.1.215",
      identifierMap: { 0: "cwd" },
    };
    const content = `${renderPromptFrontmatter(record)}\n\n# Body\nYou are in the workspace.`;

    const parsed = parsePromptFrontmatter(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe(record.name);
    expect(parsed!.description).toBe(record.description);
    expect(parsed!.ccVersion).toBe(record.version);
    expect(parsed!.variables).toEqual(["cwd"]);
    expect(parsed!.body).toContain("# Body");
    expect(parsed!.body).toContain("You are in the workspace.");
  });

  it("parsePromptFrontmatter returns null without a metadata comment", () => {
    expect(parsePromptFrontmatter("Just a prompt body.")).toBeNull();
  });
});

describe("prompt-archaeology / template extraction", () => {
  it("scanTemplateLiterals tracks interpolations through a source string", () => {
    const source = [
      "const role = 'engineer';",
      "const prompt = `You are ${role}, running in ${process.cwd()}`;",
      "const css = `.box { color: red; }`;",
      "const unterminated = `no closing backtick here",
    ].join("\n");

    const templates = scanTemplateLiterals(source);
    // The unterminated literal is skipped rather than swallowing the rest of the source.
    expect(templates).toHaveLength(2);

    const prompt = templates[0]!;
    expect(prompt.interpolated).toEqual(["role", "process.cwd()"]);
    // The literal's own text keeps its placeholders; only `interpolated` extracts names.
    expect(prompt.decoded).toBe("You are ${role}, running in ${process.cwd()}");
    expect(source.slice(prompt.start, prompt.start + 1)).toBe("`");
    expect(source.slice(prompt.end - 1, prompt.end)).toBe("`");
  });

  it("scanTemplateLiterals decodes escaped backticks without losing the pair", () => {
    const source = "const x = `Reply \\`go\\` now`;";
    const templates = scanTemplateLiterals(source);
    expect(templates).toHaveLength(1);
    expect(templates[0]!.decoded).toBe("Reply `go` now");
  });

  it("extractTemplateLiterals keeps prompts and drops code or markup", () => {
    const longIdentity = [
      "You are a highly skilled software engineer with extensive knowledge in many",
      "programming languages, frameworks, design patterns, and best practices. You",
      "operate in a workspace on the user's machine, reading files, running commands",
      "and editing code to accomplish the task the user has set out for you.",
    ].join(" ");
    const longRules = [
      "Cline operates inside a workspace and follows a strict set of rules.",
      "====",
      "TOOL USE",
      "====",
      "You have access to a set of tools that are executed upon the user's approval.",
      "You can use one tool per message, and will receive the result of that tool use",
      "in the user's response. You use tools step by step to accomplish a given task.",
    ].join("\n");
    const cssBlob = [
      ".a { color: red; padding: 10px; margin: 20px; font-size: 14px; }",
      ".b { border-radius: 4px; display: flex; position: absolute; z-index: 10; }",
      ".c { width: 100%; height: 50vh; background-color: #eee; opacity: 0.5; }",
      ".d { text-align: center; line-height: 1.5; box-shadow: 0 1px 2px #000; }",
    ].join("\n");

    const source = [
      "const a = `" + longIdentity + "`;",
      "const b = `" + longRules + "`;",
      "const c = `too short to be a prompt`;",
      "const d = `" + cssBlob + "`;",
    ].join("\n");

    const result = extractTemplateLiterals(source, { explain: true });
    expect(result.totalFound).toBe(4);
    expect(result.kept).toBe(2);

    const verdicts = new Map(result.decisions.map((d) => [d.template.decoded, d.verdict]));
    expect(verdicts.get(longIdentity)).toBe("kept-strong-prefix");
    expect(verdicts.get(longRules)).toBe("kept-structure-marker");
    expect(verdicts.get("too short to be a prompt")).toBe("dropped-too-short");
    expect(verdicts.get(cssBlob)).toBe("dropped-code-or-markup");
  });

  it("honours a custom minLength filter", () => {
    const source = "const a = `You are a short one.`;";
    expect(extractTemplateLiterals(source).kept).toBe(0);
    expect(extractTemplateLiterals(source, { minLength: 5 }).kept).toBe(1);
  });
});

describe("prompt-archaeology / injection markers", () => {
  it("findInjectionMarkers reports every harness control marker", () => {
    const text = [
      "<!--",
      'name: "captured"',
      "-->",
      "<system-reminder>you are in cwd</system-reminder>",
      "[USER_PROMPT]hello[/USER_PROMPT]",
      "Clean prompt body.",
    ].join("\n");

    const markers = findInjectionMarkers(text);
    expect(markers.map((m) => m.kind).sort()).toEqual(
      ["frontmatter", "system-reminder", "user-prompt-tag"].sort(),
    );
  });

  it("leaves a vendor's own tags alone: only another harness's control flow is a marker", () => {
    // A prompt that quotes its own reminder wrapper or a few-shot tag is writing
    // its own instructions, not re-producing a harness's runtime control flow.
    const text = "A stray </image_reminder> closer.\n<example>tool call</example>";
    expect(findInjectionMarkers(text)).toEqual([]);
    expect(stripInjectionMarkers(text)).toBe(text);
  });

  it("reports nothing for a prompt that carries only its own instructions", () => {
    expect(findInjectionMarkers("You are a helpful agent. Use <read_file> to read.")).toEqual([]);
  });

  it("stripInjectionMarkers removes pairs with their contents", () => {
    const text = "Before.\n<system-reminder>drop me</system-reminder>\nAfter.";
    expect(stripInjectionMarkers(text)).toBe("Before.\n\nAfter.");
  });

  it("stripInjectionMarkers keeps frontmatter when asked", () => {
    const text = '<!--\nname: "kept"\n-->\nYou are an agent.';
    expect(stripInjectionMarkers(text)).toBe("You are an agent.");
    expect(stripInjectionMarkers(text, { keepFrontmatter: true })).toBe(
      '<!--\nname: "kept"\n-->\nYou are an agent.',
    );
  });

  it("stripInjectionMarkers honours an allow list", () => {
    const text = "<user_query>stay</user_query>\n<session>go</session>";
    expect(stripInjectionMarkers(text, { allow: ["user-query-tag"] })).toBe(
      "<user_query>stay</user_query>\n",
    );
  });

  it("normalizeMarkdown removes indentation shared by every non-blank line", () => {
    const text = "    Line one.\n    Line two.\n\n\n\n    Line three.";
    const normalized = normalizeMarkdown(text);
    expect(normalized).not.toMatch(/^ {4}/mu);
    expect(normalized).not.toContain("\n\n\n");
    expect(normalized).toBe("Line one.\nLine two.\n\nLine three.");
  });

  it("normalizeMarkdown strips markers and unifies line endings", () => {
    const text = ['<!--\nname: "x"\n-->\r\n', "Body line.\r\nSecond line.\r\n"].join("");
    const normalized = normalizeMarkdown(text);
    expect(normalized).not.toContain("<!--");
    expect(normalized).not.toContain("\r");
    expect(normalized).toBe("Body line.\nSecond line.");
  });
});

describe("prompt-archaeology / tool-call format detection", () => {
  it("detects the xml-tags convention", () => {
    const detected = detectToolCallFormat(
      "Tool use is formatted using XML-style tags.\n<read_file>\n<path>src/main.js</path>\n</read_file>",
    );
    expect(detected.format).toBe("xml-tags");
    expect(detected.evidence).toContain("<read_file>");
  });

  it("detects the artifact-tags convention", () => {
    const detected = detectToolCallFormat("Emit a <boltArtifact> block with edits.");
    expect(detected.format).toBe("artifact-tags");
  });

  it("detects the search-replace convention", () => {
    expect(detectToolCallFormat("<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE").format).toBe(
      "search-replace",
    );
  });

  it("detects the json-schema convention", () => {
    const detected = detectToolCallFormat(
      'Call tools with ```json\n{"type": "function", "additionalProperties": false}\n```',
    );
    expect(detected.format).toBe("json-schema");
  });

  it("detects the python-dsl convention", () => {
    const detected = detectToolCallFormat(
      "Use standard python calling syntax.\ndef solve(a: int) -> str:\n    pass",
    );
    expect(detected.format).toBe("python-dsl");
  });

  it("reports none for plain prose", () => {
    expect(detectToolCallFormat("You are a helpful assistant.")).toEqual({
      format: "none",
      evidence: [],
    });
  });
});

describe("prompt-archaeology / placeholders and budget", () => {
  it("detectInterpolationStyle recognises all three placeholder syntaxes", () => {
    expect(detectInterpolationStyle("You are in ${cwd}")).toBe("dollar-brace");
    expect(detectInterpolationStyle("Feedback: {{ feedback_comment }}")).toBe("double-brace");
    expect(detectInterpolationStyle("Read {wiki_system_prompt} now")).toBe("single-brace");
    expect(detectInterpolationStyle("No placeholders here")).toBe("none");
  });

  it("extractVariables collects placeholder names in first-seen order", () => {
    expect(
      extractVariables("${cwd} and {{ task }} then ${cwd} again and {wiki_system_prompt}"),
    ).toEqual(["cwd", "task", "wiki_system_prompt"]);
  });

  it("interpolatePrompt substitutes placeholders without evaluating them", () => {
    expect(interpolatePrompt("You are in ${cwd}", { cwd: "/home/x" })).toBe("You are in /home/x");
    expect(interpolatePrompt("{{ name }}!", { name: "Ada" })).toBe("Ada!");
    expect(interpolatePrompt("{policy}", { policy: "P" })).toBe("P");

    // A value can never become executable syntax: it is inserted literally.
    const hostile = "${danger}";
    expect(interpolatePrompt("${placeholder}", { placeholder: hostile })).toBe(hostile);
  });

  it("interpolatePrompt honours the missing-placeholder policy", () => {
    expect(interpolatePrompt("${keep} ${blank}", {}, { missing: "keep" })).toBe("${keep} ${blank}");
    expect(interpolatePrompt("${keep} ${blank}", {}, { missing: "blank" })).toBe(" ");
    expect(() => interpolatePrompt("${x}", {}, { missing: "throw" })).toThrow(/no supplied value/);
  });

  it("promptTokenBudget measures a prompt against a context window", () => {
    const small = promptTokenBudget("You are an agent.", 200_000);
    expect(small.withinBudget).toBe(true);
    expect(small.budget).toBe(Math.floor(200_000 * 0.15));

    const oversized = promptTokenBudget("a".repeat(200_000), 200_000);
    expect(oversized.withinBudget).toBe(false);
  });
});
