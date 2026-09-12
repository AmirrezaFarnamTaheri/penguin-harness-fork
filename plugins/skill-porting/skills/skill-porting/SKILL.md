---
name: skill-porting
description: Port externally sourced skills into Penguin safely by pinning the source, reviewing the complete dependency closure, normalizing metadata, preserving support files, and verifying the installed result before activation.
---

# Skill Porting

Use this workflow to port a skill from a Git repository, marketplace, archive, or local directory into Penguin's installed-skill layout.

## Safety and provenance are blocking gates

1. Resolve the exact source and prefer a commit SHA or immutable release tag.
2. Record upstream repository, revision, license, and the files actually imported.
3. Review `SKILL.md` plus every referenced script, reference, asset, template, and helper before installation.
4. Refuse or quarantine content when redistribution rights are unclear, required files are absent, code is obfuscated, or the skill attempts to weaken host safety controls.
5. Never advertise a catalogue pointer or incomplete directory as an executable skill.

## Installed layout

```text
<app_data_dir>/agents/<agent_id>/agent_state/skills/<skill_name>/
├── SKILL.md
├── icon.svg              # optional
├── scripts/              # optional
├── references/           # optional
└── assets/               # optional
```

`SKILL.md` must use the canonical uppercase filename. The directory and frontmatter `name` are the skill identity and must match exactly. Use lowercase letters, digits, and hyphens only, with a maximum of 64 characters.

## Naming, categorization, and routing

Names are routing contracts, not marketing labels. Prefer the narrowest stable capability name that distinguishes the skill from its siblings.

- Avoid generic single-word verbs such as `review`, `test`, `debug`, `plan`, or `draft`. Use a domain + purpose name such as `diff-correctness-review` or `project-test-runner`.
- Preserve product/service names for service-specific automation. `*-automation` means automation for the named external service and should not compete for generic automation requests.
- Use `*-patterns` / `*-best-practices` for reference guidance, `*-runner` for execution workflows, `*-review` for inspection/audit workflows, `*-author` for artifact authoring, and `*-bilingual` only for a genuinely bilingual specialization.
- Do not rename two semantically different skills merely because their descriptions overlap. Consolidate only exact or demonstrably equivalent workflows.
- When replacing a legacy name, keep one canonical skill and add a compatibility alias. The alias must resolve directly to an installed canonical target; chains and cycles are forbidden.
- Add precise descriptions and tags that state both positive applicability and important exclusions. Routing should prefer explicit canonical names, then explicit aliases, then distinctive name tokens/tags/domain evidence, and use description text only as weaker evidence.

Before and after any naming or consolidation change, run:

```bash
pnpm skills:check
pnpm skills:catalog
```

For a port whose instructions reference local scripts/assets/shared resources, also run the strict closure check:

```bash
node scripts/skills/audit.mjs --check --strict-resources
```

The generated taxonomy report identifies exact-body duplicate candidates, suffix/stem overlap families, ambiguous single-word names, inferred domains/kinds, and routing tokens. Treat overlap entries as review candidates, not automatic deletion instructions.

## Normalize frontmatter

Penguin library/plugin versions use a dated sequence so updates can be compared deterministically. Do **not** write `version: 1`.

```md
---
name: <skill_name>
description: <specific one-line description>
short_description: <optional concise UI description>
short_description_zh: <optional Chinese UI description>
version: 2026.09.12.1
updated: 2026-09-12T00:00:00Z
---
```

Use `YYYY.MM.DD.N` for new versions. An existing legacy `YYYY-MM-DD.N` installed version may be preserved during migration, but new writes should use the dotted form. Increment `N` for another release on the same date.

External YAML can contain block scalars, arrays, nested metadata, and additional host-specific keys. Preserve semantic information that matters to execution, but normalize the installed metadata to fields Penguin actually supports. Do not silently flatten structured values into misleading strings.

## Dependency closure

A port is complete only when every relative dependency referenced by `SKILL.md` exists in the candidate directory. Recursively include required support files. Keep binary assets as bytes; never decode arbitrary files as UTF-8 merely to move them.

Reject the candidate when:

- a referenced file is absent;
- an executable step refers to code that was not imported;
- an alias points to a missing skill;
- a symlink escapes the candidate root;
- the package's license does not permit the intended redistribution;
- a required connector/runtime has no Penguin equivalent and the workflow cannot be rewritten faithfully.

## Deterministic helper scripts

If a skill repeatedly performs parsing, normalization, validation, file generation, or another deterministic transformation, put that logic in a small reviewed helper under `scripts/` instead of expanding `SKILL.md` with repeated procedural code.

For new JavaScript helpers, prefer `.mjs` and the repository's Node >= 24 runtime. A helper must:

- use explicit inputs and deterministic outputs;
- avoid hidden network access or destructive defaults;
- fail non-zero on invalid input;
- keep paths relative to the skill root unless a user explicitly supplies another destination;
- document its command line in `SKILL.md`;
- be included in the dependency-closure audit; and
- have at least one representative successful invocation and one failure/validation case exercised before activation.

Do not invent a wrapper merely to make an incomplete upstream package look executable. If the real implementation is absent, quarantine or classify the skill as reference-only instead.

## Staging and installation

Work in a scratch directory first. Never copy directly over the active installed directory.

1. Build a complete staged candidate.
2. Validate metadata, paths, dependency closure, and file encodings/types.
3. Move the existing installed directory to a backup name.
4. Atomically rename the staged directory into place.
5. If the final rename fails, restore the backup before reporting failure.
6. Remove the backup only after the new installation is verified.
7. Serialize installs per skill name so concurrent updates cannot interleave.

## Verification

Before declaring success, verify all of the following:

- canonical `SKILL.md` exists;
- frontmatter name matches the directory;
- version parses as `YYYY.MM.DD.N` (or accepted legacy date form during migration);
- every referenced support file exists;
- binary assets retain their original bytes;
- aliases resolve to installed canonical targets without cycles;
- executable commands reference files that actually exist;
- a failed replacement can restore the previous working installation;
- a renamed or consolidated skill still routes correctly for representative positive and negative prompts.

Report the pinned source revision, any normalization performed, any content deliberately excluded, and the verification evidence.
