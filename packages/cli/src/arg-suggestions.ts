const SAFE_COMMAND_TOKEN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const SAFE_OPTION_TOKEN = /^(?:-[A-Za-z]|--[A-Za-z][A-Za-z0-9-]{0,31})$/;

/** Return a unique near-match from a command/option vocabulary, never a user value. */
export function suggestKnownToken(
  input: string,
  vocabulary: readonly string[],
): string | undefined {
  if (input.length > 32 || input.includes("/") || input.includes("\\")) return undefined;
  const safe = SAFE_COMMAND_TOKEN.test(input) || SAFE_OPTION_TOKEN.test(input);
  if (!safe) return undefined;

  const normalized = input.toLocaleLowerCase("en-US");
  const maxDistance = normalized.length >= 7 ? 2 : 1;
  let bestDistance = maxDistance + 1;
  let best: string | undefined;
  let tied = false;
  const seen = new Set<string>();

  for (const candidate of vocabulary) {
    const key = candidate.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    const distance = boundedLevenshtein(normalized, key, maxDistance);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }
  return bestDistance <= maxDistance && !tied ? best : undefined;
}

/** Levenshtein distance with row-minimum and length bounds; returns maxDistance + 1 if far. */
export function boundedLevenshtein(left: string, right: string, maxDistance: number): number {
  if (!Number.isSafeInteger(maxDistance) || maxDistance < 0)
    throw new RangeError("Maximum edit distance must be a non-negative safe integer");
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  if (left === right) return 0;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = new Array<number>(right.length + 1);
    current[0] = row;
    let minimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
      const insertion = current[column - 1]! + 1;
      const deletion = previous[column]! + 1;
      const distance = Math.min(substitution, insertion, deletion);
      current[column] = distance;
      if (distance < minimum) minimum = distance;
    }
    if (minimum > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length]! <= maxDistance ? previous[right.length]! : maxDistance + 1;
}
