/**
 * Positional slash-command matching for the chat input (pure logic, unit-tested):
 * a `/` opens the command menu from ANY caret position — it must sit at the start of the
 * text or be preceded by whitespace (so URLs and paths like `a/b` never trigger it), with
 * only command characters between the `/` and the caret. Running a command removes just the
 * `start..end` token, leaving the rest of the text intact.
 */

/** Command characters allowed between `/` and the caret (command names and skill names: letters, digits, underscore, hyphen). */
const CMD_PREFIX = /^[\w-]*$/;

/** The slash token currently being typed: `start` is the index of `/`, `query` is the text between `/` and the caret (no leading slash), `end` extends over the same token to the right of the caret. */
export interface SlashMatch {
  start: number;
  end: number;
  query: string;
}

/** Finds the slash command currently being typed at the caret; returns null if none. */
export function matchSlash(text: string, caret: number): SlashMatch | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("/");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (!CMD_PREFIX.test(query)) return null;
  const rest = /^[\w-]*/.exec(text.slice(caret))![0];
  return { start: at, end: caret + rest.length, query };
}

/** Removes the matched token from the text (what a slash command's run leaves behind); collapses a doubled space at the seam. */
export function removeSlashToken(text: string, match: SlashMatch): string {
  const before = text.slice(0, match.start);
  const after = text.slice(match.end);
  // Only the seam is touched: the token used to separate its two neighbours, so dropping it would
  // leave `a  b` — one of those two spaces goes. The rest of the draft stays byte-for-byte (a
  // global collapse would silently reflow pasted code, YAML, aligned tables and indentation).
  const joined =
    before.endsWith(" ") && after.startsWith(" ") ? before + after.slice(1) : before + after;
  // The token was the entire content (possibly padded with whitespace): leave a truly empty input.
  return /^\s*$/.test(joined) ? "" : joined;
}

/** Slash command shape accepted by filterSlashCommands. */
export interface SlashCommandLike {
  cmd: string;
  desc?: string;
}

/**
 * Filters and ranks slash commands against a search query.
 * Matches:
 * 1. Exact command name match (highest priority, score: 0)
 * 2. Command name prefix (score: 10..40 based on length delta)
 * 3. Word-boundary in command (e.g. "creative" matches "ai-skills-creative-thinking", score: 50..)
 * 4. Substring in command name (score: 100 + index)
 * 5. Word-boundary in description (score: 200)
 * 6. Substring in description (score: 300)
 * 7. Multi-token match across command and description (score: 400)
 */
export function filterSlashCommands<T extends SlashCommandLike>(
  commands: T[],
  rawQuery: string,
): T[] {
  const query = rawQuery.trim().toLowerCase().replace(/^\//, "");
  if (!query) return commands;

  const tokens = query.split(/\s+/).filter(Boolean);
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundaryRegex = new RegExp(`(?:^|[-_\\s])${escapedQuery}`, "i");

  interface ScoredItem {
    item: T;
    score: number;
  }

  const scored: ScoredItem[] = [];

  for (const item of commands) {
    const rawCmd = item.cmd.toLowerCase().replace(/^\//, "");
    const desc = (item.desc || "").toLowerCase();

    // 1. Exact command name match
    if (rawCmd === query) {
      scored.push({ item, score: 0 });
      continue;
    }

    // 2. Exact command prefix
    if (rawCmd.startsWith(query)) {
      scored.push({ item, score: 10 + Math.min(30, rawCmd.length - query.length) });
      continue;
    }

    // 3. Word boundary match in command (e.g., "-creative", "_creative", or after separator)
    if (boundaryRegex.test(rawCmd)) {
      scored.push({ item, score: 50 + Math.min(40, rawCmd.length - query.length) });
      continue;
    }

    // 4. Substring anywhere in command name
    const cmdIndex = rawCmd.indexOf(query);
    if (cmdIndex >= 0) {
      scored.push({ item, score: 100 + Math.min(50, cmdIndex) });
      continue;
    }

    // 5. Description word boundary
    if (boundaryRegex.test(desc)) {
      scored.push({ item, score: 200 });
      continue;
    }

    // 6. Substring in description
    if (desc.includes(query)) {
      scored.push({ item, score: 300 });
      continue;
    }

    // 7. Multi-token match: all whitespace-separated query tokens present in cmd or desc
    if (tokens.length > 1) {
      const allMatch = tokens.every((t) => rawCmd.includes(t) || desc.includes(t));
      if (allMatch) {
        scored.push({ item, score: 400 });
      }
    }
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.item);
}
