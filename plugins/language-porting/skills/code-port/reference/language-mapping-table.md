# Cross-language mapping table

The expanded companion to the mapping table in `code-port`'s `SKILL.md`. Source column is TypeScript and Python — the two languages this product is ported *from*. Targets are Rust, Go, C#, C++.

Every row below is vocabulary, not permission. The row tells you which target constructs can express the source concept; the source's tests and callers tell you which one is correct. Read the row, then verify.

## Absence and nullity

| Concept | Rust | Go | C# | C++ |
| --- | --- | --- | --- | --- |
| absent value | `Option<T>` / `None` | pointer-nil, or paired bool | `T?` nullable | `std::optional<T>` |
| `null` vs `undefined` (two states) | `Option<Option<T>>` or a 3-variant enum | sentinel + bool, hand-rolled | `null` vs `default(T)` vs absent | `optional<optional<T>>` |
| missing map key | `map.get` → `None` | comma-ok form | `TryGetValue` → false | `find` → end iterator |
| missing array element (index) | panics — as the source does | panics | throws `ArgumentOutOfRangeException` | UB; bounds check is manual |
| sentinel default (`0`, `""`) | `Default::default()` | zero value | `default(T)` | value-initialized |

The trap: a source with both `null` and `undefined` usually uses them differently — "not set" vs "set to nothing". Collapsing them is a behavior change no type can catch. Write the distinction as an explicit three-state type and let differential testing prove it unnecessary before you simplify.

## Errors and panics

| Concept | Rust | Go | C# | C++ |
| --- | --- | --- | --- | --- |
| recoverable error | `Result<T, E>` | `(T, error)` | exception, or a `Result`-like type | `std::expected` |
| unrecoverable / crash | `panic!` | `panic` | environment-terminating exception | throw past `noexcept` → terminate |
| error carried in a value | enum variant | error type with `Is`/`As` | exception hierarchy | exception or variant |
| "catch and continue" | `match` on `Err` | `if err != nil` | `try`/`catch` | `try`/`catch` |
| error chaining with context | `anyhow` / `thiserror` | `fmt.Errorf("%w", err)` | `Exception` inner | nested exception |
| cleanup on every exit path | `Drop` guards | `defer` | `using` / `finally` | RAII destructors |

Match the **failure mode**, not the idiom. If the source panics, the target should not return a `Result`, because a `Result` can be ignored — and ignored errors are silent behavior drift. If the source catches a specific error and degrades to a default, the port must catch exactly that error and degrade to exactly that default, not to a broader class.

Python's exception hierarchy and TypeScript's `Error` subclasses carry type information callers match on; `anyhow::Error` in Rust erases it. If any caller branches on error *type*, you need `thiserror` enums or `downcast`, not `anyhow`.

## Async and concurrency

| Concept | Rust | Go | C# | C++ |
| --- | --- | --- | --- | --- |
| unit of concurrent work | `tokio::task::spawn` → `JoinHandle` | goroutine | `Task.Run` → `Task` | `std::async` / thread |
| awaiting a result | `.await` on a future | channel receive or `WaitGroup` | `await task` | `future.get()` |
| fan-out, join all | `JoinSet` / `join_all` | `sync.WaitGroup`, `errgroup` | `Task.WhenAll` | barrier / vector of futures |
| first of many wins | `select!` / `tokio::select!` | `select` on channels | `Task.WhenAny` | polling or condition variable |
| cancellation | dropped `JoinHandle` / cancellation token | `context.Context` | `CancellationToken` | promise/future invalidation |
| shared mutable state | `Mutex`/`RwLock`/atomics, or channels | `sync.Mutex`/atomics, or channels | `lock`/`Monitor`, `Channel` | mutex, atomics |
| single-threaded event loop | runtime with `!Send` futures | runtime.GOMAXPROCS(1) | `SynchronizationContext` | single-threaded executor |

Cancellation is the sharpest edge. Dropping a Rust `JoinHandle` aborts the task; abandoning a Go goroutine does not; a C# `Task` keeps running unless you observe its token. If the source's behavior depends on work stopping when a caller stops waiting, verify what actually happens — most "async port" bugs are cancellation-semantics bugs wearing a disguise.

Determinism note: `Promise.all` in JavaScript resolves in array order regardless of completion order. `JoinSet` results come in completion order. If the source's tests depend on order, sort explicitly or assert on a set.

## Generics and dispatch

| Concept | Rust | Go | C# | C++ |
| --- | --- | --- | --- | --- |
| parameterized type | `<T>` with trait bounds | type parameters (1.18+) | `<T>` with constraints | `template<typename T>` |
| ad-hoc polymorphism | traits, `impl` blocks | no equivalent — interfaces only | interfaces / static abstracts | concepts / overloads |
| static dispatch | monomorphization (default) | monomorphization | reified generics | templates, always |
| dynamic dispatch | `dyn Trait` | interface value | interface / virtual | virtual / `std::any` |
| variance | declared on lifetimes/types | no variance in user generics | declared (`in`/`out`) | nothing comparable |
| associated type / family | associated types in traits | n/a | no | n/a |
| existential type | `impl Trait` | n/a | no | `auto`/constrained templates |

Python has no generics at runtime — a Python "generic" is a docstring. Port the *constraint* the code actually relies on (it usually only ever uses one or two types) and write that as the bound, rather than reaching for the maximally generic signature.

## Closures and functions as values

| Concept | Rust | Go | C# | C++ |
| --- | --- | --- | --- | --- |
| closure capturing by reference | `Fn` borrow captures | closure over local vars | `Func<>` closing over vars | `[&]` lambda |
| closure consuming captures | `FnOnce` | not expressible | not expressible | `[x]` by-value lambda |
| mutable closure | `FnMut` | closure mutating captured | `Action<>` | `[&]` with mutation |
| function pointer, no capture | `fn` pointer | `func` type | `delegate` | function pointer / `std::function` |
| partial application | manual or `Partial`-style | manual | curried methods | `std::bind` |

Go and C# cannot express a move-capturing closure; when the source's closure consumes its captures, that is a real constraint — port it as an explicit struct with a method, and note the structural change.

## Modules, packages and visibility

| Concept | Rust | Go | C# | C++ |
| --- | --- | --- | --- | --- |
| module unit | crate / `mod` | package | assembly + namespace | translation unit + namespace |
| public | `pub` | capitalized identifier | `public` | header-declared |
| internal to the unit | private (default) / `pub(crate)` | lowercase identifier | `internal` | anonymous namespace / file-local |
| re-export | `pub use` | dot-import or re-export | `using static` | `using` |
| circular module dep | forbidden — restructure | allowed | allowed | allowed (with care) |
| entrypoint | `fn main` / `#[tokio::main]` | `func main` | `static void Main` | `int main` |

Rust forbids circular module dependencies. When the source has two modules that mutually reference, the seam goes between them: extract the shared piece into a third module before porting either. This is the one place where the target language legitimately forces a structural change — record it as a deviation with the reason, not as a silent "I cleaned this up".

## Collections and order

| Concept | Rust | Go | C# | C++ |
| --- | --- | --- | --- | --- |
| ordered map | `BTreeMap` | none in std — build it | `SortedDictionary` | `std::map` |
| hash map | `HashMap` (random order) | `map` (random order) | `Dictionary` (insertion-ish, not guaranteed) | `unordered_map` |
| ordered set | `BTreeSet` | none in std | `SortedSet` | `std::set` |
| insertion-order iteration | `Vec` of pairs or `indexmap` | slice of pairs | `List` of pairs | `vector<pair>` |
| stable sort | `sort_by` is stable | `slices.SortStable` | `OrderBy` is stable | `std::stable_sort` |

JavaScript object key order is [integer-like keys ascending, then insertion order] and Python dicts are insertion-ordered. If any test asserts on key order, the target's default map is probably wrong; pick an ordered structure deliberately, in the parity list, and apply it port-wide.

## Numbers and text

| Concept | Rust | Go | C# | C++ |
| --- | --- | --- | --- | --- |
| unbounded integer (Python `int`) | `num-bigint` | `math/big` | `System.Numerics.BigInteger` | no std equivalent |
| JS `number` | `f64` | `float64` | `double` | `double` |
| integer division | truncates toward zero | truncates | truncates | truncates |
| modulo of a negative | follows C (`%` sign of dividend) | follows C | follows C | follows C |
| float NaN equality | `is_nan()` — `NaN != NaN` | `math.IsNaN` | `double.IsNaN` | `std::isnan` |
| string index unit | bytes; `char` = code point | bytes; `rune` = code point | UTF-16 code units | depends on `char` width |
| code-point count | `chars().count()` | `utf8.RuneCountInString` | `StringInfo.LengthInTextElements` | depends |
| byte length | `len()` | `len()` | `Encoding.UTF8.GetByteCount` | `.size()` (byte view) |
| grapheme-aware slice | `unicode-segmentation` crate | `golang.org/x/text/` | no std support | ICU |

String slicing is the most common off-by-one in a port. "Index 3" in a JavaScript/TypeScript string is a UTF-16 code unit, in Python a code point, in Rust a byte. Port the *unit* the source actually uses, and when the source's indices come from a byte offset (regex match positions, parser offsets) that fact must cross the boundary explicitly.

## What the table cannot tell you

- **Behavior the type system does not see**: logging text, exit codes, stdout/stderr split, file modes, signal handling, timing. Port these from the source's behavior, and cover them with the parity ledger.
- **Hidden nondeterminism**: `Promise.all` order, `Object.keys` order, map iteration, `Math.random` seeding, time-of-day formatting. Pin or control these in the differential harness or every comparison is noise.
- **Locale and timezone**: sort order, number formatting, date parsing. Both harnesses must agree, or a formatting difference reads as a parity bug forever.
- **Resource lifetimes**: a file descriptor held until GC in one language and until scope exit in another changes observable behavior on Windows (locked files) and on Linux (fd exhaustion). When the source relies on timely cleanup, make cleanup explicit in the port.
