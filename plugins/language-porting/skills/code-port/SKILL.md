---
name: code-port
description: Port one source file or one cohesive module from a source language into a target language without changing behavior — Phase A produces a logic-correct draft that does not need to compile yet, Phase B compiles module by module in dependency order, marking every uncertain spot and keeping a running parity list of every semantic difference.
---

# Code Port

Port a single source file — or one cohesive module small enough to hold in your head at once — from a source language into a target language, **without changing what the code does**. A port is a translation, not a rewrite: the program on the other side must answer the same inputs the same way. Rewriting "while I'm in there" is how ports silently change behavior, and it is the single most common cause of a parity bug that surfaces months later in production rather than in a test.

The unit of work is the module, not the feature. Port one module to completion, then the next. A half-ported codebase in two languages at once is a debugging surface, not progress.

## Before you start

- If the message only names this skill without a concrete porting task, ask which file or module ports to which language before doing anything.
- Read the source module end to end before writing a single line of the target. A port written from a skimming of the source is a paraphrase, and paraphrases drop behavior.
- Identify the module's boundary: its public exports, its callers, and the tests that cover it. The boundary is what must survive the port intact; internals may be restructured to fit the target language.
- Know the target language's build, format and test commands before you start Phase B. Porting into a language whose toolchain you cannot run produces an unverified artifact.
- Have a place for the parity list open from the first line — a `PARITY.md` next to the port, or the ledger from the `port-verify` skill. Every deviation you notice while reading goes in it immediately; the ones you defer are the ones you forget.

## When to use

- A single file or cohesive module has a clear target language and the translation is the work.
- A larger port has already been decomposed by `port-architecture`, and you are working one module from the seam map.
- Do **not** use this for a greenfield implementation in a new language — there is nothing to be faithful to. Use the target language's own skills, e.g. `rust-skill` or `go-skill`.

## Phase A — produce a logic-correct draft

Goal: a complete target-language rendering of the module's logic. It does **not** need to compile, and it will not. It needs to be *complete and faithful* — every branch, every field, every side effect, every error path of the source present in some form.

1. **Reproduce the module skeleton verbatim.** Same file name, same module/package path, same declaration order, same names for exported items. Rename only when the target language forces you (a reserved word, a naming-convention linter), and record every rename in the parity list with the reason.
2. **Preserve field order in records and structs.** Field order is observable — serialization, memory layout tests, reflection, and debug output all see it. Reordering fields "to group related things" is a behavior change that no type checker will catch.
3. **Preserve control flow shape.** Translate `for` to the target's loop, `break`/`continue` to their equivalents, early returns to early returns. Do not fuse loops, hoist conditionals, or convert a loop to a recursion because it reads better in the target. That is an optimization, and optimizations belong in Phase B at the earliest — after parity is proven.
4. **Translate semantics, not vibes.** The question for every construct is never "what is the idiomatic equivalent" but "what does this actually do at runtime, and what target construct does exactly that". See the mapping table below and the expanded version in [`reference/language-mapping-table.md`](reference/language-mapping-table.md).
5. **Carry every comment that encodes a "why".** Comments explaining a non-obvious constraint or a past bug are part of the module's behavior contract — port them. Comments that only narrate the code can be dropped.
6. **Leave a marker everywhere you are not certain.** Write `UNCERTAIN(reason)` inline at the exact spot — not in a separate notes file, not in your head. A marker next to the code is found by the next reader; a note elsewhere is not. Be specific: `UNCERTAIN(source swallowsENOENT and returns null; target's File::open returns Err — verify the original test for EACCES)`.
7. **Do not compile, do not fix compiler errors yet.** Phase A ends when every line of the source has a target counterpart and the parity list is current. Compiling midway tempts you to delete the behavior the type checker is complaining about.

Phase A's deliverable: a draft whose every paragraph you can point at and say which source lines it renders, plus a parity list with no empty "I'll come back to this" entries.

## Phase B — compile by module

Goal: a module that builds, and whose tests pass against the original. Order matters as much as correctness.

1. **Order modules by dependency, leaves first.** Port and compile a module that depends only on already-porting-or-target-stdlib modules before touching one that depends on it. Compiling a module whose dependency is still half-written forces you to invent an interface you will then have to change twice.
2. **Get one module fully compiling before starting the next.** A backlog of "almost compiling" modules is unpayable debt: each one's errors reference names the others keep changing.
3. **Resolve `UNCERTAIN` markers in the module you are compiling, and only there.** Resolution means reading the source again — its tests, its callers, its git history — until you know the actual behavior. Then replace the marker with the faithful code and delete the parity-list entry, or upgrade it to a recorded deviation.
4. **Errors are symptoms, not chores.** A borrow-checker, ownership or nullability error is the type system telling you the draft's data lifetimes do not match the source's. Fix the lifetime to match the source; do not relax the type, add `unsafe`/`any`/`@SuppressWarnings`, or clone your way past it. Every escape hatch used here is a latent parity bug.
5. **Run that module's tests as soon as it compiles.** Not after the next module — now. A module that compiles and fails its tests is unported; moving on bakes the failure in.
6. **When the source has no tests for the module, write them first** from observed behavior (read the code, run the original, capture the outputs), then port against them. Porting untested code without writing tests first is how untested behavior reaches the target language unobserved.

## Rules that keep a port honest

- **Never silently drop behavior.** If a source feature has no target equivalent — a monkeypatch, a `goto`, a reentrant lock, a dynamic `eval`, a prototype mutation — port the closest faithful equivalent *and* record the deviation with the source evidence. "Closest equivalent" means closest in observable behavior, not closest in syntax. When no equivalent exists, port the mechanism the feature was compensating for (often the source was working around a limitation the target does not have) and write down what you did and why.
- **Infer ownership, error and concurrency from the source's actual behavior, not from your default taste.** Does the source *actually* propagate this error, or does it catch and degrade? Is this value *actually* shared mutably across threads, or does the borrow checker's complaint reveal that it is not? Does this generic *actually* need variance, or only `Display`? Answer from the source's tests and call sites; the target's type system is then a free auditor of your answer.
- **Error model: match the failure mode, not the idiom.** If the source panics on this input, the target should panic on it — do not convert it to a `Result` because it is cleaner and then have callers silently tolerate what used to crash. If the source returns a sentinel `null` on a missing key and a thrown error on a type mismatch, both must survive as distinct outcomes.
- **Null is three different things.** `null`, `undefined` and `None` are not one concept; a source with both `null` and `undefined` must not collapse them into one target value unless you have verified nothing distinguishes them. Missing key, present-but-null, and uninitialized are three states; a two-state target needs an explicit `Option` or an `UNCERTAIN`.
- **Numbers have widths.** TypeScript `number` is an f64 and Python `int` is unbounded; Rust `i32`/`f64`, Go `int`/`float64`, C# `int`/`double`, C++ `int`/`double` are not the same set. Pick the width that holds the source's actual range — checked against its tests and its fixtures, including the negative and boundary values — and record the choice. Integer division, modulo on negatives, and float-to-int truncation are port-wide decisions: make them once, in the parity list, and apply them everywhere.
- **Text is bytes until you prove otherwise.** Preserve the source's encoding semantics: byte indices vs code-point indices in strings, NFC vs NFC-folded comparison, case-folding rules, grapheme handling. Off-by-one in string slicing is the most common parity bug in ports.
- **Determinism is behavior.** If the source's output is deterministic, the port's must be — including the order of `Promise.all` resolution, `Object.keys` order, and set iteration. If the source is nondeterministic, the port may not become deterministic, or differential testing will produce noise you mistake for a bug.
- **Time and locale are inputs, not ambience.** Pin timezone and locale in both the source harness and the port for any test touching dates, formatting, sorting or parsing; a test that depends on `TZ` is not a parity test, it is a flake.
- **Side effects at the boundary are part of the contract.** Log line text, exit codes, stdout/stderr split, signal handling and file-permission bits are observable behavior. Port them, including the ones that look cosmetic.
- **Concurrency maps, it does not vanish.** Translate the source's actual happens-before relationships into the target's model — `tokio` tasks, goroutines and channels, `Task`/`Channel`s, `std::thread` — and keep the same cancellation semantics. "Await this then that" in the source is not "fire both and hope" in the target.

## How to read a module you are about to port

Read in this order, and take notes straight into the parity list:

1. **Exports and types first** — the module's public surface. This is the contract that must survive.
2. **Callers second** — what the outside world assumes about return values, errors and ordering. Callers reveal the parts of the contract the types do not express: "this function is expected to never fail", "this array is expected non-empty".
3. **Tests third** — the recorded expectations, including the ones that assert surprising things. A test that looks like it is asserting a quirk *is* asserting a quirk.
4. **Implementation last, line by line**, mapping each construct to the target as you go.

Reading the implementation first is how ports end up faithful to the reader's summary of the code instead of to the code.

## A faithful translation, in miniature

Source (TypeScript):

```ts
export function lookup(map: Map<string, number>, key: string): number {
  const v = map.get(key);           // undefined when absent
  if (v === undefined) throw new MissingKey(key);
  if (v < 0) return 0;
  return v;
}
```

Faithful Rust:

```rust
pub fn lookup(map: &Map<String, i64>, key: &str) -> i64 {
    let v = map.get(key);           // None when absent
    let v = match v {
        None => panic!("MissingKey({key:?})"),   // source THREW; parity list records the throw
        Some(v) => *v,
    };
    if v < 0 { return 0; }
    v
}
```

Two decisions here are port-level, not line-level, and both belong in the parity list: `number` became `i64` (verified against the fixture range, not guessed), and a thrown error became a panic rather than a `Result` — because the source's callers do not catch it, and converting it to a recoverable error would let new callers silently tolerate a condition the original treated as fatal. The `UNCERTAIN` you would write while drafting is whether any caller does in fact wrap this call in `try`; Phase B resolves it by reading the call sites, not by guessing.

## What a port may change, and what it may not

The boundary between the two is the module's **public surface**: the exported names, their signatures, the values they return, the errors they raise, and the order in which observable things happen. Everything outside that surface is the outside world's business and must not move. Everything inside it is implementation, and the target language may legitimately need it restructured.

| May change | Must not change |
| --- | --- |
| internal data structures (a list → a map, a class → an enum of variants) | exported names, unless the target language forces a rename — and then it is recorded |
| internal control flow that produces the same observable result | the order of observable side effects |
| internal helper functions, their number and shape | the set of error conditions and which one fires when |
| memory representation and ownership strategy | return values for every input, including the invalid ones |
| performance characteristics | the meaning of each parameter and each returned value |
| private visibility and module layout | serialization and display output, byte for byte |

When a restructure is forced — a circular dependency the target forbids, a closure the target cannot express, a lifetime the target's checker rejects — the parity list gets an entry naming the source lines that changed shape and why. A restructure that is merely convenient gets no such entry, because it is not allowed.

## The cross-language mapping table

The condensed reference; the full version with edge cases is in [`reference/language-mapping-table.md`](reference/language-mapping-table.md). Source column is TypeScript/Python, the two languages this product is ported *from*.

| Concept | Rust | Go | C# | C++ |
| --- | --- | --- | --- | --- |
| `null` / `None` | `Option<T>`, `None` = absent | pointer or `ok`-style pair; no sugar | `nullable T?` | `std::optional<T>` |
| `undefined` vs `null` | two-variant enum or `Option<Option<T>>` | separate sentinel + bool | separate `null` vs default | `optional<optional<T>>` |
| thrown error | `Result<T, E>` returned | `(T, error)` returned | exception (or `Result`-like) | exception or `std::expected` |
| panicked / crashed | `panic!` (unrecoverable) | `panic` (unrecoverable) | exception, then termination | throw past `noexcept` = terminate |
| `async`/`await` | `tokio`/async runtime, `JoinHandle` | goroutine + channel | `Task`, `async`/`await` | `std::async`, coroutines |
| fan-out then join | `join_all` / `JoinSet` | `sync.WaitGroup` or errgroup | `Task.WhenAll` | barrier / `std::future` vector |
| generics | traits + lifetimes, monomorphized | type parameters, no covariance | generics + constraints | templates or `concepts` |
| closures capturing | move/borrow, `Fn`/`FnMut`/`FnOnce` | closure over captured vars | `Func<>` with captures | lambdas, `[=]`/`[&]` |
| module / package | crate + `mod`, `pub` visibility | package, exported vs unexported | assembly + namespace, `internal` | headers + namespaces, TU visibility |
| dynamic dispatch | `dyn Trait` object | interface value | interface / virtual | virtual / `std::any` |
| `Map` insertion order | `BTreeMap` for ordered, else `HashMap` | ordered map only by hand | `Dictionary` is unordered | `std::map` ordered, `unordered_map` |
| integer division / modulo | truncates; negatives follow C | truncates | truncates | truncates |
| string index unit | byte slices, `char` is code point | byte slices, runes decoded | UTF-16 code units | `char`/byte view, depends |

Read the row, then verify against the source's tests — the table tells you the target's *vocabulary*, the tests tell you which word is correct.

## Port the tests too, they are part of the behavior

A port whose tests were rewritten is a port whose contract was rewritten. The source's test suite is a fixture as much as the code is:

- Port the tests **first**, before the implementation, whenever the module has them — a ported test suite is the only spec precise enough to catch a wrong port.
- Port assertions literally, including the ones that look incidental. An assertion on exact string output, on array order, on an error's message text, is recording behavior. "Cleaning it up" to assert something more reasonable is deleting a requirement.
- Fixtures are data, not configuration: copy them byte for byte, record their SHA-256 (see `port-verify`), and never regenerate one through either language's serializer.
- Test the ported module with the **ported tests** and the ported module against the **original's** captured outputs. Both. The first catches implementation drift; the second is the only thing that catches a test suite ported to match the port.
- When a source test cannot be expressed in the target — it monkeypatches a module, freezes time, or inspects private state — record it as a deviation. Do not substitute a weaker test and call it the same coverage.

## Handoff

- Report what ported, in dependency order, with each module's compile and test result observed — not "it should work", the command you ran and its exit status.
- Deliver the parity list with the module: deviations with source evidence, resolved `UNCERTAIN` markers, and any number-width, string-index and determinism decisions made port-wide.
- State plainly what is **not** verified: modules with no source tests, behaviors you inferred from reading rather than running, and anything behind an `UNCERTAIN` marker that survived Phase B.
- Hand off to `port-verify` before claiming done. A compiled, green-tested port is a candidate, not a proof; the parity ledger and differential run against the original are the proof.
