export interface ArbiterClaim {
  file: string;
  /** Inclusive, one-based range with start <= end; absent means the whole file. */
  lines?: { start: number; end: number };
  assertion: string;
}

/**
 * Partitions claims by exact file/text equality and inclusive line overlap, without NLP.
 * Only claims in a conflicting pair are disputed; input order and duplicates are preserved.
 */
export function synthesizeDialecticalConflict(claims: readonly ArbiterClaim[]): {
  agreements: ArbiterClaim[];
  contradictions: Array<{ file: string; claims: ArbiterClaim[] }>;
} {
  const byFile = new Map<string, ArbiterClaim[]>();
  for (const claim of claims) {
    const group = byFile.get(claim.file);
    if (group) group.push(claim);
    else byFile.set(claim.file, [claim]);
  }

  const disputed = new Set<ArbiterClaim>();
  const contradictions: Array<{ file: string; claims: ArbiterClaim[] }> = [];
  for (const [file, group] of byFile) {
    const indexed = [...group.entries()];
    for (const [i, a] of indexed) {
      for (const [j, b] of indexed) {
        if (j <= i) continue;
        const overlaps =
          !a.lines || !b.lines || (a.lines.start <= b.lines.end && b.lines.start <= a.lines.end);
        if (overlaps && a.assertion !== b.assertion) {
          disputed.add(a);
          disputed.add(b);
        }
      }
    }
    const conflicting = group.filter((claim) => disputed.has(claim));
    if (conflicting.length) contradictions.push({ file, claims: conflicting });
  }

  return {
    agreements: claims.filter((claim) => !disputed.has(claim)),
    contradictions,
  };
}
