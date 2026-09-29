/**
 * Fully-qualified names and the ONE identity builder.
 *
 * Scheme (Bikach/codeGraph, cluster-D item #6): `pkg.Name` when a package exists (Java/Kotlin),
 * else `filePath::Name` (TS/JS/Python/Go). `::` cannot appear in dotted FQNs, so a namespace can
 * never collide with a file-scoped name. Members are `${containerFqn}.${name}`; constructors are
 * `${containerFqn}.<init>` (never a node of their own — rewritten to a USES edge); anonymous
 * functions are `<anonymous>@line`.
 *
 * The single `entityIdOf()` builder exists because the absorbed ChrisRoyse pipeline had TWO id
 * builders that drifted (pass 1 emitted `function:path:name:LINE`, pass 2 looked up
 * `function:path:name`) and silently lost every named-import→function edge. One builder, used by
 * extractor, resolver and writer alike, is the whole fix.
 */

export interface FqnContext {
  /** Workspace-relative file path with forward slashes. */
  filePath: string;
  /** Package/namespace when the language has one (Java, Kotlin, C#, PHP…). */
  packageName?: string;
}

const SEPARATOR = "::";

/** Normalize a file path to the canonical forward-slash, workspace-relative form. */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** File-level identity root: `pkg` if a package exists, else the normalized file path. */
export function fileScope(ctx: FqnContext): string {
  const pkg = ctx.packageName?.trim();
  return pkg !== undefined && pkg !== "" ? pkg : normalizePath(ctx.filePath);
}

/** A top-level or nested declaration: `pkg.Name` or `filePath::Name`. */
export function fqnOf(ctx: FqnContext, name: string): string {
  return `${fileScope(ctx)}${SEPARATOR}${name}`;
}

/** A member of a container: `${containerFqn}.${name}`. */
export function memberFqn(containerFqn: string, name: string): string {
  return `${containerFqn}.${name}`;
}

/** The constructor identity of a type — never a node, always rewritten to USES. */
export function constructorFqn(containerFqn: string): string {
  return `${containerFqn}.<init>`;
}

/** An anonymous function/closure identity, anchored to its declaration line. */
export function anonymousFqn(ctx: FqnContext, line: number): string {
  return `${fileScope(ctx)}${SEPARATOR}<anonymous>@${line}`;
}

/** How a raw name should be identified. */
export type EntityKind =
  | "file"
  | "function"
  | "method"
  | "class"
  | "interface"
  | "struct"
  | "trait"
  | "enum"
  | "variable"
  | "import";

/**
 * The single entity-id builder. Every layer that needs a stable node id calls this and nothing
 * else; changing the format here changes it everywhere at once (and the test suite pins the
 * shape so a drift cannot land silently).
 */
export function entityIdOf(kind: EntityKind, fqn: string): string {
  return `${kind}:${fqn}`;
}

/** Parse an entity id back into its parts (tools render these; the round trip must hold). */
export function parseEntityId(id: string): { kind: EntityKind; fqn: string } | null {
  const separatorAt = id.indexOf(":");
  if (separatorAt <= 0) return null;
  const kind = id.slice(0, separatorAt) as EntityKind;
  const fqn = id.slice(separatorAt + 1);
  if (fqn === "") return null;
  return { kind, fqn };
}

/** True when `candidate` is reachable from `scope` without escaping it (path containment). */
export function isWithinScope(scope: string, candidate: string): boolean {
  const s = normalizePath(scope).replace(/\/+$/, "");
  const c = normalizePath(candidate);
  return c === s || c.startsWith(`${s}/`);
}
