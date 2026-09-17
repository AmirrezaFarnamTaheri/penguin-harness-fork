import { describe, expect, it } from "vitest";
import {
  synthesizeDialecticalConflict,
  type ArbiterClaim,
} from "../src/features/consensus/arbiter";

const claim = (file: string, assertion: string, lines?: ArbiterClaim["lines"]): ArbiterClaim => ({
  file,
  assertion,
  ...(lines === undefined ? {} : { lines }),
});

describe("dialectical debate arbiter", () => {
  it("reports everything as agreements for an empty debate", () => {
    const result = synthesizeDialecticalConflict([]);
    expect(result.agreements).toEqual([]);
    expect(result.contradictions).toEqual([]);
  });

  it("reports a single claim as an agreement with no contradictions", () => {
    const only = claim("src/a.ts", "exports parseTree");
    const result = synthesizeDialecticalConflict([only]);
    expect(result.agreements).toEqual([only]);
    expect(result.contradictions).toEqual([]);
  });

  it("merges same-file claims with disjoint line ranges as agreements", () => {
    const upper = claim("src/a.ts", "handles the header section", { start: 1, end: 10 });
    const lower = claim("src/a.ts", "handles the footer section", { start: 50, end: 60 });
    const result = synthesizeDialecticalConflict([upper, lower]);
    expect(result.agreements).toEqual([upper, lower]);
    expect(result.contradictions).toEqual([]);
  });

  it("merges claims about different files as agreements even with identical lines", () => {
    const left = claim("src/left.ts", "declares the router", { start: 1, end: 5 });
    const right = claim("src/right.ts", "declares the router", { start: 1, end: 5 });
    const result = synthesizeDialecticalConflict([left, right]);
    expect(result.agreements).toEqual([left, right]);
    expect(result.contradictions).toEqual([]);
  });

  it("isolates same-file overlapping-range claims that assert different things", () => {
    const saysValid = claim("src/a.ts", "validation passes for all inputs", { start: 10, end: 20 });
    const saysBroken = claim("src/a.ts", "validation rejects numeric input", {
      start: 15,
      end: 25,
    });
    const result = synthesizeDialecticalConflict([saysValid, saysBroken]);
    expect(result.agreements).toEqual([]);
    expect(result.contradictions).toEqual([{ file: "src/a.ts", claims: [saysValid, saysBroken] }]);
  });

  it("treats unbounded claims (no lines) as spanning the whole file, so they conflict", () => {
    const bounded = claim("src/a.ts", "the parser is pure", { start: 1, end: 2 });
    const unbounded = claim("src/a.ts", "the parser mutates its input");
    const result = synthesizeDialecticalConflict([bounded, unbounded]);
    expect(result.agreements).toEqual([]);
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]?.claims).toEqual([bounded, unbounded]);
  });

  it("keeps a shared assertion on overlapping lines out of the contradictions", () => {
    const first = claim("src/a.ts", "returns null on empty input", { start: 5, end: 8 });
    const second = claim("src/a.ts", "returns null on empty input", { start: 7, end: 12 });
    const result = synthesizeDialecticalConflict([first, second]);
    expect(result.agreements).toEqual([first, second]);
    expect(result.contradictions).toEqual([]);
  });

  it("groups every disagreeing claim on one file into a single contradiction entry", () => {
    const one = claim("pkg/x.ts", "uses a map", { start: 1, end: 9 });
    const two = claim("pkg/x.ts", "uses a list", { start: 3, end: 12 });
    const three = claim("pkg/x.ts", "uses a set", { start: 9, end: 20 });
    const result = synthesizeDialecticalConflict([one, two, three]);
    expect(result.agreements).toEqual([]);
    expect(result.contradictions).toEqual([{ file: "pkg/x.ts", claims: [one, two, three] }]);
  });

  it("outputs one contradiction entry per disputed file in input order", () => {
    const aBad = claim("a.ts", "sync writes", { start: 1, end: 4 });
    const aOther = claim("a.ts", "async writes", { start: 2, end: 6 });
    const bBad = claim("b.ts", "retry twice", { start: 1, end: 3 });
    const bOther = claim("b.ts", "retry once", { start: 2, end: 5 });
    const result = synthesizeDialecticalConflict([aBad, bBad, aOther, bOther]);
    expect(result.contradictions.map((entry) => entry.file)).toEqual(["a.ts", "b.ts"]);
    expect(result.contradictions[0]?.claims).toEqual([aBad, aOther]);
    expect(result.contradictions[1]?.claims).toEqual([bBad, bOther]);
  });

  it("treats shared boundary lines as overlapping (inclusive ranges)", () => {
    const head = claim("src/a.ts", "covers the imports", { start: 1, end: 4 });
    const tail = claim("src/a.ts", "covers the exports", { start: 4, end: 8 });
    const result = synthesizeDialecticalConflict([head, tail]);
    expect(result.agreements).toEqual([]);
    expect(result.contradictions).toEqual([{ file: "src/a.ts", claims: [head, tail] }]);
  });

  it("isolates only disputed claims, preserving agreement order across files", () => {
    const a = claim("a.ts", "safe", { start: 1, end: 2 });
    const b = claim("b.ts", "safe", { start: 1, end: 2 });
    const laterA = claim("a.ts", "safe", { start: 10, end: 12 });
    const dispute = claim("a.ts", "unsafe", { start: 11, end: 11 });
    const last = claim("a.ts", "unrelated", { start: 20, end: 22 });
    expect(synthesizeDialecticalConflict([a, b, laterA, dispute, last])).toEqual({
      agreements: [a, b, last],
      contradictions: [{ file: "a.ts", claims: [laterA, dispute] }],
    });
  });

  it("does not compare assertions across files or normalize their text", () => {
    const a = claim("a.ts", "SAFE", { start: 1, end: 1 });
    const b = claim("b.ts", "unsafe", { start: 1, end: 1 });
    expect(synthesizeDialecticalConflict([a, b]).agreements).toEqual([a, b]);
    const lower = claim("a.ts", "safe", { start: 1, end: 1 });
    const space = claim("a.ts", "safe ", { start: 1, end: 1 });
    expect(synthesizeDialecticalConflict([a, lower, space])).toEqual({
      agreements: [],
      contradictions: [{ file: "a.ts", claims: [a, lower, space] }],
    });
  });

  it("compares two whole-file claims and retains identical duplicate claims", () => {
    const a = claim("a.ts", "safe");
    const b = claim("a.ts", "unsafe");
    expect(synthesizeDialecticalConflict([a, b])).toEqual({
      agreements: [],
      contradictions: [{ file: "a.ts", claims: [a, b] }],
    });
    expect(synthesizeDialecticalConflict([a, a])).toEqual({
      agreements: [a, a],
      contradictions: [],
    });
  });

  it("handles containment and matching single-line ranges", () => {
    const outer = claim("a.ts", "safe", { start: 1, end: 10 });
    const inner = claim("a.ts", "unsafe", { start: 5, end: 5 });
    const sameLine = claim("a.ts", "unknown", { start: 5, end: 5 });
    expect(synthesizeDialecticalConflict([outer, inner, sameLine])).toEqual({
      agreements: [],
      contradictions: [{ file: "a.ts", claims: [outer, inner, sameLine] }],
    });
  });

  it("is deterministic and does not mutate frozen input or line ranges", () => {
    const a = Object.freeze(claim("a.ts", "safe", Object.freeze({ start: 1, end: 10 })));
    const b = Object.freeze(claim("a.ts", "unsafe", Object.freeze({ start: 3, end: 4 })));
    const input = Object.freeze([a, b]);
    const expected = { agreements: [], contradictions: [{ file: "a.ts", claims: [a, b] }] };
    expect(synthesizeDialecticalConflict(input)).toEqual(expected);
    expect(synthesizeDialecticalConflict(input)).toEqual(expected);
    expect(input).toEqual([a, b]);
  });
});
