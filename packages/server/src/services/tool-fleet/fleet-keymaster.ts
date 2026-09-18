/**
 * Fleet keymaster: the server's credential vault service.
 *
 * Owns one {@link EncryptedCredentialStore} for the process and adds the layer a server
 * needs on top of a vault: id allocation, provider-scoped lookups, expiry bookkeeping, and
 * the connection between a PKCE handshake's token response and the stored record.
 *
 * Nothing here ever returns a secret to a caller that is not about to use it. The HTTP
 * surface gets {@link listCredentials} (metadata only); the mesh gets the store itself via
 * {@link getStore}. The linchpin rule, from the harness's own plugin-library conventions:
 * projections are allowlists, so a field added to the credential type does not start
 * travelling to the API until someone adds it here on purpose.
 */
import { randomUUID } from "node:crypto";
import {
  CREDENTIAL_AUTH_SCHEMES,
  CredentialStoreError,
  EncryptedCredentialStore,
  CONNECTION_STATUS,
  PkceError,
  tokenExpiry,
  type CredentialAuthScheme,
  type CredentialPersistence,
  type CredentialSetOptions,
  type EncryptedCredentialStoreOptions,
  type PkceProviderConfig,
  type StoredCredential,
  type TokenResponse,
} from "@prismshadow/penguin-core";

export interface FleetKeymasterOptions {
  /** Master passphrase; defaults to the machine-bound identifier. */
  masterKey?: string;
  /** Vault file. Defaults to a file beside the harness's other server data. */
  filePath?: string;
  /** Credential id prefix, so server-stored ids never collide with imported ones. */
  idPrefix?: string;
}

/** A credential as the API describes it — metadata only, never a secret. */
export interface CredentialItem {
  id: string;
  providerId: string;
  authScheme: CredentialAuthScheme;
  status: "active" | "expiring" | "expired" | "revoked";
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  scopes?: readonly string[];
  accountId?: string;
}

export class FleetKeymasterError extends Error {
  constructor(
    readonly code:
      "unknown_credential" | "not_initialized" | "bad_provider" | "no_secret" | "vault_error",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FleetKeymasterError";
  }
}

const DEFAULT_PREFIX = "cred";

/** Warned this far ahead of expiry, so a UI can prompt a reauth before a break. */
export const EXPIRY_WARN_MS = 24 * 60 * 60 * 1000;

export class FleetKeymaster {
  /**
   * The vault. `undefined` once {@link dispose} has zeroed its key: a disposed store can
   * never serve again, so the reference is dropped rather than left pointing at a corpse.
   * {@link load} builds a fresh one.
   */
  private store: EncryptedCredentialStore | undefined;
  private readonly storeOptions: EncryptedCredentialStoreOptions;
  private readonly idPrefix: string;
  private loaded = false;

  constructor(options: FleetKeymasterOptions = {}) {
    this.storeOptions = {
      ...(options.masterKey !== undefined ? { masterKey: options.masterKey } : {}),
      ...(options.filePath !== undefined ? { filePath: options.filePath } : {}),
    };
    this.store = new EncryptedCredentialStore(this.storeOptions);
    this.idPrefix = options.idPrefix ?? DEFAULT_PREFIX;
  }

  /**
   * The live vault, for the mesh to resolve a credential at call time. Throws rather than
   * handing out a store whose key has been wiped.
   */
  getStore(): EncryptedCredentialStore {
    return this.requireStore();
  }

  /** Lifetime of the credentials this keymaster holds. */
  persistence(): CredentialPersistence {
    return this.requireStore().persistence();
  }

  /** Loads the vault. Idempotent; safe to call at every boot, and after a dispose. */
  async load(): Promise<number> {
    // A dispose wipes the key; only a newly built store can hold a fresh one.
    if (!this.store) {
      this.store = new EncryptedCredentialStore(this.storeOptions);
    }
    const count = await this.store.load();
    this.loaded = true;
    return count;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * The vault, once `load()` has armed it. `load` reports success only after a store
   * exists, so this narrows both flags at once; `dispose` clears both, and any access
   * afterwards has to load again.
   */
  private requireLoaded(action: string): EncryptedCredentialStore {
    if (!this.loaded || !this.store) {
      throw new FleetKeymasterError(
        "not_initialized",
        `Cannot ${action} before FleetKeymaster.load()`,
      );
    }
    return this.store;
  }

  /** The live vault, or the reason there is not one. */
  private requireStore(): EncryptedCredentialStore {
    if (!this.store) {
      throw new FleetKeymasterError(
        "not_initialized",
        "FleetKeymaster has been disposed; call load() to rebuild the vault",
      );
    }
    return this.store;
  }

  /**
   * Allocates a credential id. Deterministic only in shape — the entropy comes from the
   * crypto RNG, so an id is not guessable and cannot be enumerated.
   */
  allocateId(providerId: string): string {
    if (!providerId) throw new FleetKeymasterError("bad_provider", "providerId is required");
    return `${this.idPrefix}_${providerId}_${randomUUID()}`;
  }

  /** Stores a raw secret (an API key or a pre-obtained token). */
  async storeSecret(
    providerId: string,
    authScheme: CredentialAuthScheme,
    secret: string,
    options: CredentialSetOptions = {},
  ): Promise<StoredCredential> {
    const store = this.requireLoaded("store a secret");
    if (!secret) throw new FleetKeymasterError("no_secret", "A secret is required");
    const id = options.accountId ?? this.allocateId(providerId);
    return store.set(id, providerId, authScheme, secret, options);
  }

  /**
   * Persists the result of a completed PKCE exchange. The refresh token, when the provider
   * issued one, is what gets stored as the durable secret: access tokens expire, and a
   * stored access token alone cannot be refreshed unattended.
   */
  async storeTokenResponse(
    providerId: string,
    config: PkceProviderConfig,
    response: TokenResponse,
    options: { accountId?: string; now?: number } = {},
  ): Promise<StoredCredential & { expiresAt?: number }> {
    const store = this.requireLoaded("store a token");
    const now = options.now ?? Date.now();
    const durable =
      response.refresh_token ??
      // A service-account or API-key-shaped response carries no refresh token; the access
      // token is the durable credential then, and expiry bookkeeping records it as such.
      response.access_token;
    const expiresAt = tokenExpiry(response, now);
    // Providers that do not echo the granted scopes are read from the config instead: the
    // scopes we requested are the best available record of what the token is good for.
    const declaredScope = response.scope ?? config.defaultScopes;
    // `typeof` narrows the union where `Array.isArray` does not: the array branch of the
    // guard leaves a `readonly string[]` unassignable to `any[]`, so it never narrows away.
    const scopes =
      declaredScope === undefined
        ? undefined
        : typeof declaredScope === "string"
          ? declaredScope.split(" ").filter((part) => part.length > 0)
          : declaredScope;

    const stored = await store.set(
      options.accountId ?? this.allocateId(providerId),
      providerId,
      CREDENTIAL_AUTH_SCHEMES[0],
      durable,
      {
        createdAt: now,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
        ...(options.accountId !== undefined ? { accountId: options.accountId } : {}),
      },
    );
    // The access token is kept under a companion id so an invocation can present the
    // short-lived bearer value without a second round-trip to the provider.
    if (response.refresh_token !== undefined) {
      await store.set(
        `${stored.id}:access`,
        providerId,
        CREDENTIAL_AUTH_SCHEMES[0],
        response.access_token,
        {
          createdAt: now,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
        },
      );
    }
    return { ...stored, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  }

  /** Reads the durable secret (refresh token or API key) for a credential id. */
  async getSecret(id: string): Promise<string> {
    const store = this.requireLoaded("read a secret");
    try {
      return (await store.get(id)).secret;
    } catch (error) {
      throw this.wrapStoreError(error, id);
    }
  }

  /** Reads the short-lived access token companion record, when one exists. */
  async getAccessToken(id: string): Promise<string | undefined> {
    const store = this.requireLoaded("read an access token");
    try {
      return (await store.get(`${id}:access`)).secret;
    } catch (error) {
      if (error instanceof CredentialStoreError && error.kind === "not_found") return undefined;
      throw this.wrapStoreError(error, id);
    }
  }

  /** Deletes a credential and its access-token companion. */
  async revoke(id: string): Promise<void> {
    const store = this.requireLoaded("revoke a credential");
    try {
      await store.delete(id);
    } catch (error) {
      throw this.wrapStoreError(error, id);
    }
    try {
      await store.delete(`${id}:access`);
    } catch (error) {
      if (!(error instanceof CredentialStoreError) || error.kind !== "not_found") {
        throw this.wrapStoreError(error, `${id}:access`);
      }
    }
  }

  /** Whether a credential id is present. */
  has(id: string): boolean {
    return this.store?.has(id) ?? false;
  }

  /** Every credential's metadata, with derived status. Secrets are never included. */
  listCredentials(now: number = Date.now()): readonly CredentialItem[] {
    // A disposed vault reports an empty fleet rather than throwing: the health surface
    // reads this unconditionally, and the honest answer is "nothing is served right now".
    const records = this.store?.list() ?? [];
    return records.map((record) => ({
      id: record.id,
      providerId: record.providerId,
      authScheme: record.authScheme,
      status: credentialStatus(record.expiresAt, now),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
      ...(record.scopes !== undefined ? { scopes: record.scopes } : {}),
      ...(record.accountId !== undefined ? { accountId: record.accountId } : {}),
    }));
  }

  /** Credentials for one provider. */
  credentialsForProvider(providerId: string, now: number = Date.now()): readonly CredentialItem[] {
    return this.listCredentials(now).filter((item) => item.providerId === providerId);
  }

  /** Credentials expiring within {@link EXPIRY_WARN_MS}, soonest first. */
  expiringSoon(now: number = Date.now()): readonly CredentialItem[] {
    return this.listCredentials(now)
      .filter((item) => item.status === "expiring" || item.status === "expired")
      .sort(
        (a, b) =>
          (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY),
      );
  }

  /** Releases the vault's in-memory key. Reads go quiet until `load()` rebuilds it. */
  dispose(): void {
    this.store?.dispose();
    // The key is zeroed in place; this instance can never serve again. Drop it so the
    // next load() builds a fresh vault rather than reusing a dead one.
    this.store = undefined;
    this.loaded = false;
  }

  private wrapStoreError(error: unknown, id: string): FleetKeymasterError {
    if (error instanceof CredentialStoreError) {
      return new FleetKeymasterError(
        error.kind === "not_found" ? "unknown_credential" : "vault_error",
        error.kind === "not_found" ? `No credential stored as '${id}'` : error.message,
        { cause: error },
      );
    }
    return new FleetKeymasterError(
      "vault_error",
      `Credential vault failure: ${(error as Error).message}`,
      { cause: error as Error },
    );
  }
}

/** Maps an expiry to a lifecycle status; absent expiry means the secret does not expire. */
export function credentialStatus(
  expiresAt: number | undefined,
  now: number,
): CredentialItem["status"] {
  if (expiresAt === undefined) return "active";
  if (now >= expiresAt) return "expired";
  if (expiresAt - now <= EXPIRY_WARN_MS) return "expiring";
  return "active";
}

export { PkceError, CONNECTION_STATUS };
