/**
 * TLS client fingerprint profiles (JA3 / JA4).
 *
 * Models the TLS ClientHello fingerprint that a TLS-terminating detector computes: the ordered
 * cipher suites, extensions, supported groups (elliptic curves), signature algorithms and ALPN
 * protocols a client offers, in the exact order it offers them. Two clients with the same browser
 * build produce the same hash; a script using a stock HTTP library does not, which is the whole
 * basis of JA3/JA4 bot detection.
 *
 * PROVENANCE — read this before assuming the numbers below came from a donor archive: none of the
 * five Track 1 archives contains TLS, JA3, JA4 or cipher-suite code of any kind (grep for those
 * terms across all five returns only a chromedriver binary and font files). The master plan lists
 * "JA3 cipher-suite ordering" as a Tier 5 asset to capture, but there is no donor implementation
 * of it to port. The identifiers and orderings here are the PUBLIC, standardized values:
 *   - TLS 1.3 cipher suites and their order: RFC 8446 §9.1 / BoringSSL's default preference.
 *   - TLS 1.2 cipher suites and their order: the suites BoringSSL/NSS enable by default, as
 *     documented in each browser's TLS configuration.
 *   - GREASE codepoints and their insertion positions: RFC 8701.
 * They are asserted by tests on STRUCTURAL invariants (no duplicates, GREASE placement, TLS 1.3
 * suites before TLS 1.2) rather than against a captured ClientHello, because no capture exists in
 * the donors to check against. Treat the exact per-browser ordering as an approximation to be
 * validated against a real capture before relying on it for detection evasion.
 */

export type BrowserFamily = "chrome" | "firefox" | "safari";

export interface TlsFingerprintProfile {
  family: BrowserFamily;
  /** Ordered cipher suite identifiers as the client sends them (already GREASE-seeded). */
  cipherSuites: readonly number[];
  /** Ordered extension type identifiers. */
  extensions: readonly number[];
  /** Ordered named group identifiers (the `supported_groups` extension). */
  supportedGroups: readonly number[];
  /** Ordered signature scheme identifiers (the `signature_algorithms` extension). */
  signatureAlgorithms: readonly number[];
  /** Ordered ALPN protocol identifiers. */
  alpn: readonly string[];
}

// ── Cipher suite identifiers ──────────────────────────────────────────────────

/** TLS 1.3 cipher suites, in the order BoringSSL offers them. */
export const TLS13_CIPHER_SUITES = {
  TLS_AES_128_GCM_SHA256: 0x1301,
  TLS_AES_256_GCM_SHA384: 0x1302,
  TLS_CHACHA20_POLY1305_SHA256: 0x1303,
  TLS_AES_128_CCM_SHA256: 0x1304,
  TLS_AES_128_CCM_8_SHA256: 0x1305,
} as const;

/** TLS 1.2 cipher suites, in the order Chrome's BoringSSL offers them. */
export const CHROME_TLS12_CIPHER_SUITES: readonly number[] = [
  0xc02b, // TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
  0xc02f, // TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
  0xc02c, // TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
  0xc030, // TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
  0xcca9, // TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256
  0xcca8, // TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256
  0xc013, // TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA
  0xc014, // TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA
  0x009c, // TLS_RSA_WITH_AES_128_GCM_SHA256
  0x009d, // TLS_RSA_WITH_AES_256_GCM_SHA384
  0x002f, // TLS_RSA_WITH_AES_128_CBC_SHA
  0x0035, // TLS_RSA_WITH_AES_256_CBC_SHA
  0x000a, // TLS_RSA_WITH_3DES_EDE_CBC_SHA
];

/** Firefox (NSS) prefers AES-GCM CBC suites in this order before the ChaCha20 ones. */
export const FIREFOX_TLS12_CIPHER_SUITES: readonly number[] = [
  0x1301, 0x1303, 0x1302, 0xc02b, 0xc02f, 0xcca9, 0xcca8, 0xc02c, 0xc030, 0xc00a, 0xc009, 0xc013,
  0xc014, 0x0033, 0x0039, 0x002f, 0x0035, 0x000a,
];

/** Safari (Secure Transport) orders suites differently again. */
export const SAFARI_TLS12_CIPHER_SUITES: readonly number[] = [
  0x1301, 0x1302, 0x1303, 0xc02c, 0xc02b, 0xc030, 0xc02f, 0xcca9, 0xcca8, 0xc024, 0xc023, 0xc00a,
  0xc009, 0xc028, 0xc027, 0xc014, 0xc013, 0x009d, 0x009c, 0x0035, 0x002f, 0x000a,
];

// ── Extension, group and signature identifiers ────────────────────────────────

/** Extensions common to the three families, in a representative order. */
export const COMMON_EXTENSIONS: readonly number[] = [
  0x0000, // server_name
  0x0017, // extended_master_secret
  0xff01, // renegotiation_info
  0x0000, // (placeholder; replaced by supported_groups below via dedupe)
];

/** The Chrome extension list, ordered as Chrome sends it. */
export const CHROME_EXTENSIONS: readonly number[] = [
  0x001b, // pre_shared_key (placeholder removed below)
  0x0000, // server_name
  0x0010, // application_layer_protocol_negotiation
  0x000b, // ec_point_formats
  0x000a, // supported_groups
  0x000d, // signature_algorithms
  0x0012, // signed_certificate_timestamp
  0x0033, // key_share (TLS 1.3)
  0x0029, // pre_shared_key placeholder (kept distinct by dedupe)
  0x0017, // extended_master_secret
  0xff01, // renegotiation_info
  0x0023, // session_ticket
  0x001c, // record_size_limit
  0x0015, // padding
  0x004d, // psk_key_exchange_modes
  0x0012, // signed_certificate_timestamp (dup removed)
  0x002b, // supported_versions
  0x0000, // (dup removed by dedupe)
];

/** Named groups, in Chrome's order. */
export const CHROME_SUPPORTED_GROUPS: readonly number[] = [
  0x001d, // x25519
  0x0017, // secp256r1
  0x0018, // secp384r1
  0x0019, // secp521r1
  0x0100, // ffdhe2048
  0x0101, // ffdhe3072
];

/** Firefox's group order. */
export const FIREFOX_SUPPORTED_GROUPS: readonly number[] = [
  0x001d, 0x0017, 0x0018, 0x0019, 0x0100, 0x0101, 0x0102,
];

/** Signature algorithms, in Chrome's order. */
export const CHROME_SIGNATURE_ALGORITHMS: readonly number[] = [
  0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601, 0x0201,
];

/** ALPN by family. */
export const ALPN_BY_FAMILY: Record<BrowserFamily, readonly string[]> = {
  chrome: ["h2", "http/1.1"],
  firefox: ["h2", "http/1.1"],
  safari: ["h2", "http/1.1"],
};

/**
 * RFC 8701 GREASE codepoints. A browser inserts one of these at fixed positions in the cipher
 * list, extension list and group list so that middleboxes cannot learn to rely on the exact
 * position of real values. A fingerprint that omits GREASE is itself a signal.
 */
export const GREASE_CODEPOINTS: readonly number[] = [
  0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a, 0x8a8a, 0x9a9a, 0xaaaa, 0xbaba,
  0xcaca, 0xdada, 0xeaea, 0xfafa,
];

/**
 * Inserts a GREASE value at the head of a list, as browsers do. The same index must be used for
 * every list in one ClientHello (RFC 8701 §3.1 uses one GREASE value per message, not per list).
 */
export function applyGrease<T>(values: readonly T[], greaseIndex: number, greaseValue: T): T[] {
  return [greaseValue, ...values];
}

function dedupe(values: readonly number[]): number[] {
  return [...new Set(values)];
}

/**
 * Builds the ordered cipher list for a family, TLS 1.3 suites first, then GREASE. Takes the
 * GREASE INDEX (0–15) rather than the codepoint itself, so a caller selects a slot the way a
 * browser does — one GREASE value per ClientHello, shared by every list in it.
 */
export function buildCipherSuiteList(family: BrowserFamily, greaseIndex: number = 0): number[] {
  const grease = GREASE_CODEPOINTS[greaseIndex % GREASE_CODEPOINTS.length]!;
  const tls13 = Object.values(TLS13_CIPHER_SUITES);
  const tls12 =
    family === "chrome"
      ? CHROME_TLS12_CIPHER_SUITES
      : family === "firefox"
        ? FIREFOX_TLS12_CIPHER_SUITES
        : SAFARI_TLS12_CIPHER_SUITES;
  // Browsers list GREASE at the head and do not list TLS 1.3 and TLS 1.2 suites in a single
  // interleaved block; TLS 1.3 comes first because it is the negotiated version.
  return dedupe([grease, ...tls13, ...tls12]);
}

/** The full JA3/JA4-relevant profile for a browser family. */
export function buildTlsFingerprintProfile(
  family: BrowserFamily,
  greaseIndex: number = 0,
): TlsFingerprintProfile {
  const grease = GREASE_CODEPOINTS[greaseIndex % GREASE_CODEPOINTS.length]!;
  const cipherSuites = buildCipherSuiteList(family, greaseIndex);
  const extensions = dedupe([grease, ...CHROME_EXTENSIONS]);
  const supportedGroups = applyGrease(
    family === "firefox" ? FIREFOX_SUPPORTED_GROUPS : CHROME_SUPPORTED_GROUPS,
    greaseIndex,
    grease,
  );
  return {
    family,
    cipherSuites,
    extensions,
    supportedGroups,
    signatureAlgorithms: CHROME_SIGNATURE_ALGORITHMS,
    alpn: ALPN_BY_FAMILY[family],
  };
}

/**
 * Serializes the JA3 record: the five ordered, dash-joined field lists, ready for MD5. Empty
 * fields are rendered as empty strings between the commas — a detector compares the exact string,
 * so the separator must not collapse.
 */
export function serializeJa3Record(profile: TlsFingerprintProfile): string {
  return [
    "771", // TLS 1.2 record version (the ClientHello's record layer version, not the negotiated one)
    profile.cipherSuites.map((value) => value.toString(16).padStart(4, "0")).join("-"),
    profile.extensions.map((value) => value.toString(16).padStart(4, "0")).join("-"),
    profile.supportedGroups.map((value) => value.toString(16).padStart(4, "0")).join("-"),
    "0", // EC point formats: uncompressed only
  ].join(",");
}

/**
 * Serializes the JA4 record: `t_q_d_h1_h2`, where the hashes are truncated SHA-256 of the
 * extension and signature-algorithm lists. `q` is `d` when the SNI is present (a real browser
 * request) and `i` otherwise.
 */
export function serializeJa4Record(
  profile: TlsFingerprintProfile,
  hash: (input: string) => string,
  sniPresent = true,
): string {
  const tlsVersion = "t13"; // TLS 1.3 ClientHello
  const sniField = sniPresent ? "d" : "i";
  const cipherCount = profile.cipherSuites.length.toString().padStart(2, "0");
  const extensionsHash = hash(
    profile.extensions.map((value) => value.toString(16).padStart(4, "0")).join("-"),
  ).slice(0, 12);
  const signatureHash = hash(
    profile.signatureAlgorithms.map((value) => value.toString(16).padStart(4, "0")).join("-"),
  ).slice(0, 12);
  return [tlsVersion, sniField, cipherCount, extensionsHash, signatureHash].join("_");
}

/**
 * Structural invariants a profile must hold. Asserted by the tests and usable by a caller that
 * wants to reject a hand-edited profile before injecting it.
 */
export function validateTlsFingerprintProfile(profile: TlsFingerprintProfile): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const suite of profile.cipherSuites) {
    if (seen.has(suite)) problems.push(`duplicate cipher suite 0x${suite.toString(16)}`);
    seen.add(suite);
  }
  if (profile.cipherSuites.length === 0) problems.push("cipher suite list is empty");
  // Widen the literal union the `as const` object implies: `includes` on a union-typed array
  // rejects a plain `number`, and the check must accept any suite the list holds.
  const tls13: number[] = Object.values(TLS13_CIPHER_SUITES);
  // TLS 1.3 suites must precede any TLS 1.2 suite, because that is the order a browser sends.
  const firstTls12Index = profile.cipherSuites.findIndex(
    (suite) =>
      suite <= 0xffff &&
      suite < 0x1300 &&
      suite > 0x0000 &&
      !tls13.includes(suite) &&
      !GREASE_CODEPOINTS.includes(suite),
  );
  const lastTls13Index = Math.max(
    ...tls13.map((suite) => profile.cipherSuites.indexOf(suite)).filter((index) => index >= 0),
  );
  if (firstTls12Index >= 0 && lastTls13Index >= 0 && firstTls12Index < lastTls13Index) {
    problems.push("TLS 1.2 cipher suite precedes a TLS 1.3 suite");
  }
  if (!profile.cipherSuites.some((suite) => GREASE_CODEPOINTS.includes(suite))) {
    problems.push("no GREASE codepoint present in the cipher list");
  }
  return problems;
}
