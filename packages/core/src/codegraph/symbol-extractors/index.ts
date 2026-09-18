/**
 * Per-language extractor registry.
 *
 * Donor lineage: FastCode's `parser.parse_file` dispatch table. Unknown languages fall back to a
 * no-op extractor so the topology engine never crashes on exotic file types.
 */

import {
  detectLanguage,
  type ExtractorOutput,
  type SupportedLanguage,
  type SymbolExtractor,
} from "./language-detect.js";
import { goExtractor } from "./go.js";
import { pythonExtractor } from "./python.js";
import { rustExtractor } from "./rust.js";
import { typescriptExtractor } from "./typescript.js";

const EXTRACTORS: Partial<Record<SupportedLanguage, SymbolExtractor>> = {
  typescript: typescriptExtractor,
  javascript: typescriptExtractor,
  python: pythonExtractor,
  go: goExtractor,
  rust: rustExtractor,
};

const noopExtractor: SymbolExtractor = {
  language: "unknown",
  extract(filePath: string, content: string): ExtractorOutput {
    return {
      filePath,
      language: "unknown",
      definitions: [],
      imports: [],
      exports: [],
      linesOfCode: content.split("\n").filter((line) => line.trim().length > 0).length,
    };
  },
};

/** Look up the extractor for a file path, falling back to a no-op extractor. */
export function getExtractor(filePath: string): SymbolExtractor {
  return EXTRACTORS[detectLanguage(filePath)] ?? noopExtractor;
}

/** Extract symbols/imports for one file using the language-appropriate scanner. */
export function extractFile(filePath: string, content: string): ExtractorOutput {
  return getExtractor(filePath).extract(filePath, content);
}

export { detectLanguage } from "./language-detect.js";
export { computeCyclomaticComplexity } from "./complexity.js";
export type { ExtractorOutput, SymbolExtractor, SupportedLanguage } from "./language-detect.js";
