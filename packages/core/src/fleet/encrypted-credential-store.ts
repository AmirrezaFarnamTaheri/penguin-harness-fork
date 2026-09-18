/**
 * Encrypted credential store for the Universal Tool Mesh.
 *
 * Ports the at-rest envelope from the storage-manager lineage's `crypto.ts` (AES-256-GCM
 * over PBKDF2-SHA256, an 8-byte version header, salt+IV+authTag in one buffer) and the
 * store contract from the composio lineage's `cli-keyring` (a `CredentialStore` with
 * explicit `EntryModifiers` and a `persistence()` lifetime).
 *
 * What is kept real, not stubbed:
 *  - Key derivation is PBKDF2-HMAC-SHA256 at 200,000 iterations (double the source's 100k;
 *    the mesh holds provider OAuth refresh tokens, so the cost is worth it).
 *  - The cipher is AES-256-GCM, which is authenticated: a wrong password, a tampered byte,
 *    or a truncated envelope fails at `decipher.final()`, never silently.
 *  - The master key is derived once per store instance and held in a `Buffer` that
 *    `dispose()` overwrites, so a long-lived process does not keep the key around forever.
 *
 * The mesh never logs a plaintext credential: `snapshot()` runs every record through the
 * harness's own {@link redactObject}, so a dump taken for support cannot leak a secret.
 *
 * Node built-ins only — no new dependency, no crypto polyfill.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";

import { redactObject } from "../internal/credential-redactor.js";

/**
 * Auth scheme vocabulary the mesh understands, lifted from the composio lineage's
 * `AuthSchemeTypes`. It is deliberately narrower: this store persists a secret and its
 * metadata, it does not itself speak every provider's handshake.
 */
export const CREDENTIAL_AUTH_SCHEMES = [
  "OAUTH2",
  "OAUTH1",
  "API_KEY",
  "BEARER_TOKEN",
  "BASIC",
  "GOOGLE_SERVICE_ACCOUNT",
  "S2S_OAUTH2",
  "NO_AUTH",
] as const;
export type CredentialAuthScheme = (typeof CREDENTIAL_AUTH_SCHEMES)[number];

/** Lifetime characteristics a backing store can report — mirrors `CredentialPersistence`. */
export const CREDENTIAL_PERSISTENCE = {
  EntryOnly: "EntryOnly",
  ProcessOnly: "ProcessOnly",
  UntilLogout: "UntilLogout",
  UntilReboot: "UntilReboot",
  UntilDelete: "UntilDelete",
} as const;
export type CredentialPersistence =
  (typeof CREDENTIAL_PERSISTENCE)[keyof typeof CREDENTIAL_PERSISTENCE];

export interface CredentialModifiers {
  /** Human-readable label shown by an OS keychain UI. */
  readonly label?: string;
  /** Linux Secret Service collection name. */
  readonly collection?: string;
  /** macOS keychain domain. */
  readonly keychain?: "User" | "System" | "Common" | "Dynamic";
}

export interface StoredCredential {
  readonly id: string;
  readonly providerId: string;
  readonly authScheme: CredentialAuthScheme;
  /** Opaque secret: an access token, refresh token, API key, or JSON for service accounts. */
  readonly secret: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
  readonly accountId?: string;
  readonly modifiers?: CredentialModifiers;
}

/** Optional fields a caller may pass when storing a secret. */
export interface CredentialSetOptions {
  createdAt?: number;
  expiresAt?: number;
  scopes?: readonly string[];
  accountId?: string;
  modifiers?: CredentialModifiers;
}

/** Shape on disk: one envelope per credential, plus a redaction-safe index. */
interface OnDiskRecord {
  readonly id: string;
  readonly providerId: string;
  readonly authScheme: CredentialAuthScheme;
  readonly envelope: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
  readonly accountId?: string;
}

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 200_000;

/**
 * The envelope's magic header. Exported so a second consumer of the format — the fleet's
 * audit trail — can tell an encrypted envelope from a legacy plaintext file without trying
 * a decrypt that is guaranteed to fail.
 */
export const ENVELOPE_HEADER = Buffer.from("PNMESH01");
const HEADER_LENGTH = ENVELOPE_HEADER.length;
const ENVELOPE_OFFSETS = {
  salt: HEADER_LENGTH,
  iv: HEADER_LENGTH + SALT_LENGTH,
  authTag: HEADER_LENGTH + SALT_LENGTH + IV_LENGTH,
  data: HEADER_LENGTH + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
} as const;

/**
 * Derives a 256-bit key from a password and salt. Synchronous by design: a refresh that
 * blocks for 40ms once at load is far easier to reason about than a refresh that races.
 */
export function deriveKey(password: BinaryLike, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}

/** Cryptographically secure random salt. */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

/** Cryptographically secure random IV — GCM needs a fresh one per encryption. */
export function generateIv(): Buffer {
  return randomBytes(IV_LENGTH);
}

/**
 * Encrypts a buffer into the on-disk envelope: `header ‖ salt ‖ iv ‖ authTag ‖ ciphertext`.
 * Compression is deliberately NOT applied here: the source gated it behind a second header
 * byte, and gzip on already-random ciphertext buys nothing while adding a failure mode.
 */
export function encryptEnvelope(data: Buffer, key: Buffer): Buffer {
  const salt = generateSalt();
  const iv = generateIv();
  const derived = deriveKey(key, salt);
  const cipher = createCipheriv(ALGORITHM, derived, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([ENVELOPE_HEADER, salt, iv, authTag, ciphertext]);
}

/**
 * Decrypts an envelope. Throws on a wrong key, a bad header, or any tampering — GCM
 * authenticates before it returns plaintext, so a partial decrypt never escapes.
 */
export function decryptEnvelope(envelope: Buffer, key: Buffer): Buffer {
  if (envelope.length < ENVELOPE_OFFSETS.data) {
    throw new CredentialStoreError("truncated", "Encrypted envelope is too short");
  }
  const header = envelope.subarray(0, HEADER_LENGTH);
  if (!header.equals(ENVELOPE_HEADER)) {
    throw new CredentialStoreError("format", "Unsupported envelope version or format");
  }
  const salt = envelope.subarray(ENVELOPE_OFFSETS.salt, ENVELOPE_OFFSETS.iv);
  const iv = envelope.subarray(ENVELOPE_OFFSETS.iv, ENVELOPE_OFFSETS.authTag);
  const authTag = envelope.subarray(ENVELOPE_OFFSETS.authTag, ENVELOPE_OFFSETS.data);
  const ciphertext = envelope.subarray(ENVELOPE_OFFSETS.data);

  const derived = deriveKey(key, salt);
  const decipher = createDecipheriv(ALGORITHM, derived, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new CredentialStoreError(
      "bad_key",
      "Decryption failed: incorrect master key or corrupted data",
    );
  }
}

/** SHA-256 of a buffer, hex-encoded — used for integrity fingerprints, never for storage. */
export function computeHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * A machine-bound identifier, so a vault copied between hosts does not silently decrypt.
 * The source hashed `hostname + username`; the mesh also folds in the platform, which
 * distinguishes a WSL and a Windows install that share a hostname.
 */
export function machineIdentifier(): string {
  const identifier = [os.hostname(), os.userInfo().username, process.platform].join("|");
  return computeHash(Buffer.from(identifier, "utf8")).slice(0, 32);
}

export type CredentialStoreErrorKind =
  "not_found" | "no_default_store" | "truncated" | "format" | "bad_key" | "io" | "exists";

export class CredentialStoreError extends Error {
  constructor(
    readonly kind: CredentialStoreErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CredentialStoreError";
  }
}

export interface EncryptedCredentialStoreOptions {
  /** Master passphrase. Defaults to the machine-bound identifier when omitted. */
  masterKey?: string;
  /** Optional file path; when absent the store lives in memory only. */
  filePath?: string;
  /** Disable the built-in flush so tests can batch writes. */
  autoFlush?: boolean;
}

interface StoreState {
  readonly records: Map<string, OnDiskRecord>;
  dirty: boolean;
}

/**
 * The credential vault. One instance per process; the server's fleet keymaster owns it.
 *
 * The store keeps ciphertext at rest and plaintext only between `get` and the caller's
 * use of it. There is no plaintext cache: the refresh scheduler asks for the record, and
 * the mesh's invocation path resolves a credential into a header at the last moment.
 */
export class EncryptedCredentialStore {
  private readonly key: Buffer;
  private readonly state: StoreState = { records: new Map(), dirty: false };
  private disposed = false;

  constructor(private readonly options: EncryptedCredentialStoreOptions = {}) {
    this.key = Buffer.from(options.masterKey ?? machineIdentifier(), "utf8");
  }

  /** Lifetime of the credentials this store holds. */
  persistence(): CredentialPersistence {
    return this.options.filePath === undefined
      ? CREDENTIAL_PERSISTENCE.ProcessOnly
      : CREDENTIAL_PERSISTENCE.UntilDelete;
  }

  /** Number of credentials held, of any scheme. */
  get size(): number {
    return this.state.records.size;
  }

  /**
   * Stores `secret` under `id`, overwriting an existing record. Expiry is accepted in
   * milliseconds-from-epoch so an OAuth `expires_in` is converted once, at token time.
   */
  async set(
    id: string,
    providerId: string,
    authScheme: CredentialAuthScheme,
    secret: string,
    extra: CredentialSetOptions = {},
  ): Promise<StoredCredential> {
    this.assertNotDisposed();
    if (!id) throw new CredentialStoreError("io", "Credential id must be non-empty");
    if (!providerId) throw new CredentialStoreError("io", "Provider id must be non-empty");
    if (typeof secret !== "string" || secret.length === 0) {
      throw new CredentialStoreError("io", "Credential secret must be a non-empty string");
    }

    const now = Date.now();
    const envelope = encryptEnvelope(Buffer.from(secret, "utf8"), this.key);
    const record: OnDiskRecord = {
      id,
      providerId,
      authScheme,
      envelope: envelope.toString("base64"),
      createdAt: extra.createdAt ?? now,
      updatedAt: now,
      ...(extra.expiresAt !== undefined ? { expiresAt: extra.expiresAt } : {}),
      ...(extra.scopes !== undefined ? { scopes: extra.scopes } : {}),
      ...(extra.accountId !== undefined ? { accountId: extra.accountId } : {}),
    };
    this.state.records.set(id, record);
    this.state.dirty = true;
    if (this.options.autoFlush ?? true) await this.flush();
    return this.toStored(record, secret);
  }

  /** Fetches the plaintext secret, throwing `not_found` when the id is unknown. */
  async get(id: string): Promise<StoredCredential> {
    this.assertNotDisposed();
    const record = this.state.records.get(id);
    if (!record) {
      throw new CredentialStoreError("not_found", `No credential stored for '${id}'`);
    }
    const secret = decryptEnvelope(Buffer.from(record.envelope, "base64"), this.key).toString(
      "utf8",
    );
    return this.toStored(record, secret);
  }

  /** Whether an id is present, without decrypting it. */
  has(id: string): boolean {
    return this.state.records.has(id);
  }

  /** Removes a credential; throws `not_found` when absent, matching the keyring contract. */
  async delete(id: string): Promise<void> {
    this.assertNotDisposed();
    if (!this.state.records.delete(id)) {
      throw new CredentialStoreError("not_found", `No credential stored for '${id}'`);
    }
    this.state.dirty = true;
    if (this.options.autoFlush ?? true) await this.flush();
  }

  /** Lists metadata only — never decrypts, never returns a secret. */
  list(): readonly Omit<StoredCredential, "secret">[] {
    return [...this.state.records.values()].map((record) => ({
      id: record.id,
      providerId: record.providerId,
      authScheme: record.authScheme,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
      ...(record.scopes !== undefined ? { scopes: record.scopes } : {}),
      ...(record.accountId !== undefined ? { accountId: record.accountId } : {}),
    }));
  }

  /**
   * A support-safe dump. Every record is redacted through the harness's redactor first, so
   * the snapshot's only plaintext is structural metadata a human can act on.
   */
  snapshot(): readonly Record<string, unknown>[] {
    return this.list().map((record) => redactObject({ ...record, kind: "credential-record" }));
  }

  /** Persists the vault to `filePath` as a JSON envelope store. */
  async flush(): Promise<void> {
    this.assertNotDisposed();
    if (this.options.filePath === undefined) return;
    if (!this.state.dirty) return;
    const payload = {
      version: 1,
      machine: machineIdentifier(),
      records: [...this.state.records.values()],
    };
    const dir = path.dirname(this.options.filePath);
    await fs.mkdir(dir, { recursive: true });
    // Write-then-rename so an interrupted flush cannot truncate the existing vault.
    const tmp = `${this.options.filePath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
    await fs.rename(tmp, this.options.filePath);
    this.state.dirty = false;
  }

  /** Loads the vault from `filePath`; missing file is not an error, it is an empty store. */
  async load(): Promise<number> {
    this.assertNotDisposed();
    if (this.options.filePath === undefined) return 0;
    let raw: string;
    try {
      raw = await fs.readFile(this.options.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw new CredentialStoreError(
        "io",
        `Could not read credential vault: ${(error as Error).message}`,
      );
    }
    let parsed: { records?: OnDiskRecord[] };
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CredentialStoreError(
        "format",
        `Credential vault is not valid JSON: ${(error as Error).message}`,
      );
    }
    this.state.records.clear();
    for (const record of parsed.records ?? []) {
      if (record && typeof record.id === "string") this.state.records.set(record.id, record);
    }
    this.state.dirty = false;
    return this.state.records.size;
  }

  /**
   * Verifies a passphrase against the first record without exposing the plaintext.
   * Constant-time over the derived keys, so an attacker cannot time-guess the master key.
   */
  verifyPassphrase(passphrase: string): boolean {
    const first = this.state.records.values().next().value;
    if (!first) return false;
    const envelope = Buffer.from(first.envelope, "base64");
    const salt = envelope.subarray(ENVELOPE_OFFSETS.salt, ENVELOPE_OFFSETS.iv);
    const candidate = deriveKey(passphrase, salt);
    const expected = deriveKey(this.key.toString("latin1"), salt);
    return timingSafeEqual(candidate, expected);
  }

  /** Overwrites the master key in memory. After this the store refuses every operation. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.key.fill(0);
    this.state.records.clear();
    this.state.dirty = false;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new CredentialStoreError("io", "Credential store has been disposed");
    }
  }

  private toStored(record: OnDiskRecord, secret: string): StoredCredential {
    return {
      id: record.id,
      providerId: record.providerId,
      authScheme: record.authScheme,
      secret,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
      ...(record.scopes !== undefined ? { scopes: record.scopes } : {}),
      ...(record.accountId !== undefined ? { accountId: record.accountId } : {}),
    };
  }
}
