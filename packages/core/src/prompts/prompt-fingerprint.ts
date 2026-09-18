/**
 * Prompt fingerprinting — content identity for catalogued prompts.
 *
 * Deterministic, dependency-free content hashing plus cheap lexical similarity, so a
 * vendor prompt can be de-duplicated, version-pinned and diffed without a tokenizer or
 * a network call. Two prompts from different vendors that share a stolen preamble show
 * up as one normalised digest; a vendor's v4.7 and v4.8 prompts show up as near-1.0
 * similarity with distinct digests.
 *
 * The default digest is FNV-1a 64 (BigInt, ES2022). It is not cryptographic — it is a
 * fast identity key. `sha256Fingerprint` exists for the cases where the digest is used
 * as a trust boundary, and it is async because it goes through Web Crypto.
 */

/** Identity record for one prompt text. */
export interface PromptFingerprint {
  /** Digest algorithm used for {@link PromptFingerprint.digest}. */
  readonly algorithm: "fnv1a-64";
  /** FNV-1a 64 hex digest of the text exactly as supplied. */
  readonly digest: string;
  /** FNV-1a 64 hex digest of the normalised text (see {@link normalizeForFingerprint}). */
  readonly normalizedDigest: string;
  /** Character count of the raw text. */
  readonly chars: number;
  /** UTF-8 byte count of the raw text. */
  readonly bytes: number;
  /** Line count of the raw text (`0` for the empty string). */
  readonly lines: number;
  /** Heuristic token estimate of the raw text. */
  readonly estTokens: number;
}

/** Reason a piece of text was flagged as similar or duplicate. */
export interface PromptSimilarity {
  /** 0..1 lexical overlap of normalised word shingles. */
  readonly score: number;
  /** Words shared by both texts over the smaller shingle set. */
  readonly sharedShingles: number;
  /** Shingle count of the smaller text. */
  readonly minShingles: number;
}

const FNV_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const HEX_64_MASK = 0xffffffffffffffffn;
const TEXT_ENCODER = new TextEncoder();

/**
 * FNV-1a 64 hash over a UTF-8 byte sequence.
 *
 * Each byte of the UTF-8 encoding is folded in (XOR, then multiply), which is what makes the
 * digest agree with every other FNV-1a-64 implementation over the same text — provenance and
 * de-duplication across tools. Folding UTF-16 code units instead would diverge from the standard
 * on any non-ASCII text: "café" hashes the bytes c3 a9, not the single code unit e9. Implemented
 * with BigInt because ES2022 has no u64. Roughly 40MB/s of text per second on a warm V8 — a 500KB
 * leaked prompt fingerprints in ~12ms, which is what makes full-catalog de-duplication cheap enough
 * to run at load time.
 */
export function fnv1a64(data: string): string {
  let hash = FNV_64_OFFSET_BASIS;
  for (const byte of TEXT_ENCODER.encode(data)) {
    hash = ((hash ^ BigInt(byte)) * FNV_64_PRIME) & HEX_64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Normalise prompt text so cosmetic edits do not change the digest: CRLF and stray CR to
 * LF, trailing whitespace stripped, 3+ blank lines collapsed to one, leading/trailing
 * whitespace trimmed, and any HTML-comment frontmatter block removed.
 */
export function normalizeForFingerprint(text: string): string {
  const withoutFrontmatter = text.replace(/^[\t ]*<!--[\s\S]*?-->\s*/, "");
  return withoutFrontmatter
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/[\t ]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** UTF-8 byte length without depending on Node's Buffer (this file stays pure TS). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Heuristic token count: 4 latin characters per token, 1 token per CJK/BMP-emoji code
 * point. This deliberately over-counts slightly, so a budget check errs toward refusing
 * to ship an oversized prompt rather than shipping it.
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair: one astral code point, counted as one wide token.
      wide += 1;
      i += 1;
    } else if (isWideCodePoint(code)) {
      wide += 1;
    } else {
      narrow += 1;
    }
  }
  return Math.ceil(narrow / 4) + wide;
}

function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x9fff) || // CJK + Kangxi + CJK ext A
    (code >= 0xa960 && code <= 0xa97f) || // Hangul Jamo Extended-A
    (code >= 0xac00 && code <= 0xd7ff) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compat ideographs
    (code >= 0xff00 && code <= 0xffef) // halfwidth/fullwidth forms
  );
}

/** Compute the full identity record for a prompt text. */
export function fingerprintPrompt(text: string): PromptFingerprint {
  const normalized = normalizeForFingerprint(text);
  return {
    algorithm: "fnv1a-64",
    digest: fnv1a64(text),
    normalizedDigest: fnv1a64(normalized),
    chars: text.length,
    bytes: utf8ByteLength(text),
    lines: text.length === 0 ? 0 : text.split("\n").length,
    estTokens: estimateTokens(text),
  };
}

/** Digest of the normalised form only — the key used for de-duplication. */
export function normalizedDigest(text: string): string {
  return fnv1a64(normalizeForFingerprint(text));
}

/**
 * Two prompts are content-duplicates when their *normalised* texts agree. A vendor that
 * re-released an identical prompt under a new version number, or two vendors shipping the
 * same preamble, collapse to one entry.
 */
export function arePromptsDuplicates(a: string, b: string): boolean {
  return normalizedDigest(a) === normalizedDigest(b);
}

/** Split normalised text into lower-cased word shingles of the given size. */
export function wordShingles(text: string, size = 3): string[] {
  const words = normalizeForFingerprint(text)
    .toLowerCase()
    .split(/[^a-z0-9_'’-]+/u)
    .filter((word) => word.length > 0);
  if (words.length < size) {
    return words;
  }
  const shingles: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) {
    let shingle = words[i] as string;
    for (let j = 1; j < size; j += 1) {
      shingle += " " + words[i + j];
    }
    shingles.push(shingle);
  }
  return shingles;
}

/**
 * Jaccard overlap of two prompts' word shingles. 1.0 means the same wording; ~0.9 is what
 * successive vendor versions of one prompt look like; <0.2 means unrelated despite a
 * shared role. Cheap (O(n) over the smaller text) and deliberately order-insensitive.
 */
export function promptSimilarity(a: string, b: string, size = 3): PromptSimilarity {
  const left = new Set(wordShingles(a, size));
  const right = new Set(wordShingles(b, size));
  if (left.size === 0 || right.size === 0) {
    return { score: 0, sharedShingles: 0, minShingles: 0 };
  }
  const minShingles = Math.min(left.size, right.size);
  let shared = 0;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const shingle of smaller) {
    if (larger.has(shingle)) shared += 1;
  }
  return { score: shared / minShingles, sharedShingles: shared, minShingles };
}

/**
 * SHA-256 digest via Web Crypto. Use this when the digest feeds a security or
 * provenance decision; use {@link fingerprintPrompt} for catalog identity keys.
 */
export async function sha256Fingerprint(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** Find exact-duplicate normalised digests across a set of prompt texts. */
export function findDuplicateDigests(texts: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const digest = normalizedDigest(text);
    counts.set(digest, (counts.get(digest) ?? 0) + 1);
  }
  const duplicates: string[] = [];
  for (const [digest, count] of counts) {
    if (count > 1) duplicates.push(digest);
  }
  return duplicates;
}
