# Porting, Absorption, and Refusal Policy

This checked-in policy governs reuse and adaptation of external projects, reports, examples, and
reference checkouts. It is an engineering control, not a legal opinion. When license scope or
provenance is unclear, do not copy or integrate the material; record the uncertainty and ask for
qualified review.

## Decision vocabulary

| Decision | Meaning | Required evidence |
| --- | --- | --- |
| **ADOPT** | Use a component or code under terms compatible with this project. | Exact repository, commit, file scope, license, notices, dependency license, and required attribution are recorded. |
| **ADAPT** | Modify an eligible component while honoring its license and keeping required notices. | Same evidence as ADOPT, plus a clear record of modified files and any share-alike or disclosure obligations. |
| **REIMPLEMENT** | Build an independent implementation from a behavior-level specification. | The source is not copied; the specification, independent tests, and separation from source code are recorded. |
| **INSPIRE** | Use only a general design idea or observed behavior. | No expressive source, assets, text, or tests are copied; implementation and tests are independently authored. |
| **REFUSE** | Do not pursue the capability or transfer. | Record the refusal and its security, policy, provenance, or license reason. Do not route around it through another vendor or agent. |

## Hard refusals

Do not build, import, or recommend these capabilities in this project:

- Free-API bridges for GLM/Qwen/Gemini/DeepSeek families, account or quota rotation, or other
  access-control/billing workarounds.
- Device-fingerprint spoofing, uTLS/JA3 impersonation dialers, or traffic designed to evade provider controls.
- Vendor-binary patching, proof-of-work WASM intended to bypass service restrictions, or WAF/prompt-sanitizer stripping.
- Reverse-engineering or vendoring materials from `.assets/` directories or other expressly restricted source bundles.
- Copying proprietary or incompatible source under the mistaken assumption that the repository's top-level license covers it.

Security, provider terms, and the project’s permanent refusal list take precedence over convenience,
feature parity, or a source repository’s popularity.

## License and source review

The following are findings from prior investigations, not evergreen declarations for every current
revision. Before acting, verify the exact upstream repository, commit, file/subdirectory license,
`NOTICE` files, and dependency terms. A repository root license does not automatically cover every
subtree or vendored dependency.

| Investigated source scope | Prior review finding | Default handling |
| --- | --- | --- |
| Antigravity twins | CC BY-NC-SA material was identified in the reviewed sources. | No source/code or asset port. `INSPIRE` only from separately documented behavior; clean-room review required. |
| Budibase core | GPLv3 was identified for the reviewed core scope. | No integration or code copy without an explicit compatible-license decision; design concepts only. |
| Dify `web/` | A modified Apache license notice was identified in the reviewed frontend scope. | Recheck the exact modification and notices; do not copy frontend source until compatibility is established. |
| tldraw editor | The reviewed editor scope was identified as proprietary. | No source, assets, or code port; use only independently described general interaction ideas when appropriate. |
| Mastra `ee/**` and `connect` | ELv2 restrictions were identified for these paths. | Do not copy or use outside the applicable license grant; `INSPIRE` only from independently documented behavior. |
| PiX MPL-2.0 files | MPL-2.0 applies to covered files in the reviewed scope. | Keep required notices and comply with file-level source obligations for modifications; otherwise do not adopt the files. |
| MIT/Apache-2.0 components | Permissive terms were identified for reviewed components. | Still verify exact scope and retain copyright, license, and `NOTICE` material required by the applicable license. |

The memory retention constants in `packages/core/src/memory/retention.ts` were independently
implemented from report descriptions; the current upstream license check is recorded in that file
and in `tasks/plan.md`. No upstream implementation or tests are copied.

## Required workflow for every external transfer

1. **Identify the source.** Record its canonical URL, exact commit/tag, file paths, and the date
   checked. Treat pasted snippets, generated reports, and filenames as untrusted until matched to
   the source.
2. **Check scope and license.** Inspect the exact files, root and subtree licenses, notices,
   generated assets, and relevant dependencies. Record the chosen decision vocabulary above.
3. **State the intended transfer.** Separate facts and behavior from implementation details. Cite
   what may be adopted and explicitly exclude restricted or unrelated material.
4. **Implement within the boundary.** Preserve notices for ADOPT/ADAPT. For REIMPLEMENT/INSPIRE,
   keep the source implementation out of the coding context and author fresh code, tests, names,
   and documentation from the approved behavior specification.
5. **Verify and record.** Run the project's relevant tests, license checks, and security checks;
   record owner, affected files, validation, and rollback. Reopen the decision if the source,
   version, or intended use changes.

Do not delete a rejected source record merely to make the repository appear clean. Move a useful
historical record to the designated archive with its rejection reason; remove only disposable
copies that are not user-owned evidence or working state.
