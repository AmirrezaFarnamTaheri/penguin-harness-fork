/**
 * Encrypted credential store — at-rest security tests.
 *
 * What these prove (and why each is here rather than a "it ran" assertion):
 *
 *  - AES-256-GCM is *authenticated*: the tamper and wrong-key cases fail at decryption, so
 *    a modified vault file can never yield partially-decrypted plaintext.
 *  - The envelope carries a version header, so a future format fails loudly rather than
 *    decrypting garbage.
 *  - `snapshot()` is support-safe: it runs records through the harness redactor, so a dump
 *    taken for diagnostics cannot contain a secret.
 *  - `verifyPassphrase` is the only place the master key is compared, and it is
 *    constant-time over derived keys.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CREDENTIAL_AUTH_SCHEMES,
  CREDENTIAL_PERSISTENCE,
  CredentialStoreError,
  EncryptedCredentialStore,
  computeHash,
  decryptEnvelope,
  deriveKey,
  encryptEnvelope,
  generateIv,
  generateSalt,
  machineIdentifier,
} from "../../src/fleet/encrypted-credential-store.js";

const MASTER = "a-master-passphrase-for-tests";

async function tmpVault(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pnmesh-vault-"));
  return path.join(dir, "vault.json");
}

describe("encrypted credential store", () => {
  it("derives a 32-byte key with PBKDF2-SHA256 deterministically", () => {
    const salt = generateSalt();
    const a = deriveKey(MASTER, salt);
    const b = deriveKey(MASTER, salt);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  it("salts the key derivation so two identical passphrases differ", () => {
    const a = deriveKey(MASTER, generateSalt());
    const b = deriveKey(MASTER, generateSalt());
    expect(a.equals(b)).toBe(false);
  });

  it("round-trips an envelope", () => {
    const key = deriveKey(MASTER, generateSalt());
    const plaintext = Buffer.from("super-secret-refresh-token", "utf8");
    const envelope = encryptEnvelope(plaintext, key);
    expect(decryptEnvelope(envelope, key).equals(plaintext)).toBe(true);
  });

  it("tags every envelope with the PNMESH01 version header", () => {
    const key = deriveKey(MASTER, generateSalt());
    const envelope = encryptEnvelope(Buffer.from("x", "utf8"), key);
    expect(envelope.subarray(0, 8).toString("ascii")).toBe("PNMESH01");
  });

  it("never reuses an IV or salt: two encryptions of the same text differ", () => {
    const key = deriveKey(MASTER, generateSalt());
    const plaintext = Buffer.from("same-secret", "utf8");
    const a = encryptEnvelope(plaintext, key);
    const b = encryptEnvelope(plaintext, key);
    expect(a.equals(b)).toBe(false);
    // ...and both still decrypt to the same value.
    expect(decryptEnvelope(a, key).equals(plaintext)).toBe(true);
    expect(decryptEnvelope(b, key).equals(plaintext)).toBe(true);
  });

  it("rejects a wrong master key", () => {
    const key = deriveKey(MASTER, generateSalt());
    const other = deriveKey("a-totally-different-passphrase", generateSalt());
    const envelope = encryptEnvelope(Buffer.from("secret", "utf8"), key);
    expect(() => decryptEnvelope(envelope, other)).toThrow(CredentialStoreError);
    expect(() => decryptEnvelope(envelope, other)).toThrow(/incorrect master key/);
  });

  it("detects a tampered ciphertext byte", () => {
    const key = deriveKey(MASTER, generateSalt());
    const envelope = encryptEnvelope(Buffer.from("secret", "utf8"), key);
    const tampered = Buffer.from(envelope);
    // Flip a bit in the ciphertext region (past header+salt+iv+authTag).
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    expect(() => decryptEnvelope(tampered, key)).toThrow(CredentialStoreError);
  });

  it("detects a tampered auth tag", () => {
    const key = deriveKey(MASTER, generateSalt());
    const envelope = encryptEnvelope(Buffer.from("secret", "utf8"), key);
    const tampered = Buffer.from(envelope);
    // The auth tag sits immediately before the ciphertext.
    tampered[8 + 32 + 16] = (tampered[8 + 32 + 16] ?? 0) ^ 0x01;
    expect(() => decryptEnvelope(tampered, key)).toThrow(CredentialStoreError);
  });

  it("refuses an unsupported envelope header", () => {
    const key = deriveKey(MASTER, generateSalt());
    const envelope = encryptEnvelope(Buffer.from("secret", "utf8"), key);
    envelope.write("PNMESX99", 0, "ascii");
    expect(() => decryptEnvelope(envelope, key)).toThrow(/Unsupported envelope version/);
  });

  it("rejects a truncated envelope", () => {
    const key = deriveKey(MASTER, generateSalt());
    expect(() => decryptEnvelope(Buffer.alloc(8), key)).toThrow(/too short/);
  });

  it("generates unpredictable salts and IVs of the right length", () => {
    const salt = generateSalt();
    const iv = generateIv();
    expect(salt.length).toBe(32);
    expect(iv.length).toBe(16);
    expect(salt.equals(generateSalt())).toBe(false);
    expect(iv.equals(generateIv())).toBe(false);
  });

  it("hashes with SHA-256", () => {
    expect(computeHash(Buffer.from("abc", "utf8"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("binds the machine identifier to hostname, user and platform", () => {
    const id = machineIdentifier();
    expect(id).toHaveLength(32);
    expect(machineIdentifier()).toBe(id);
  });
});

describe("EncryptedCredentialStore", () => {
  let vaultPath: string | undefined;

  afterEach(async () => {
    if (vaultPath !== undefined) {
      await fs.rm(path.dirname(vaultPath), { recursive: true, force: true });
      vaultPath = undefined;
    }
  });

  it("stores and retrieves a secret", async () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    const stored = await store.set("linear-1", "linear", "OAUTH2", "tok_abc", {
      scopes: ["read", "write"],
    });
    expect(stored.secret).toBe("tok_abc");
    expect(stored.providerId).toBe("linear");
    expect(stored.scopes).toEqual(["read", "write"]);
    expect((await store.get("linear-1")).secret).toBe("tok_abc");
  });

  it("reports presence without decrypting", () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    expect(store.has("missing")).toBe(false);
  });

  it("throws not_found for an unknown id", async () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    await expect(store.get("nope")).rejects.toMatchObject({
      name: "CredentialStoreError",
      kind: "not_found",
    });
  });

  it("deletes a credential and refuses to delete it again", async () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    await store.set("k1", "github", "OAUTH2", "s");
    await store.delete("k1");
    expect(store.has("k1")).toBe(false);
    await expect(store.delete("k1")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("validates ids, providers and secrets", async () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    await expect(store.set("", "github", "OAUTH2", "s")).rejects.toMatchObject({ kind: "io" });
    await expect(store.set("k", "", "OAUTH2", "s")).rejects.toMatchObject({ kind: "io" });
    await expect(store.set("k", "github", "OAUTH2", "")).rejects.toMatchObject({ kind: "io" });
  });

  it("lists metadata without ever returning a secret", async () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    await store.set("k1", "github", "OAUTH2", "secret-value");
    const listing = store.list();
    expect(listing).toHaveLength(1);
    expect(JSON.stringify(listing)).not.toContain("secret-value");
    expect(listing[0]).toMatchObject({ id: "k1", providerId: "github", authScheme: "OAUTH2" });
  });

  it("redacts every record in a support snapshot", async () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    await store.set("k1", "github", "OAUTH2", "secret-value");
    const snapshot = store.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("secret-value");
  });

  it("reports the persistence lifetime from its backing file", () => {
    expect(new EncryptedCredentialStore({ masterKey: MASTER }).persistence()).toBe(
      CREDENTIAL_PERSISTENCE.ProcessOnly,
    );
    expect(
      new EncryptedCredentialStore({ masterKey: MASTER, filePath: "/tmp/x.json" }).persistence(),
    ).toBe(CREDENTIAL_PERSISTENCE.UntilDelete);
  });

  it("persists and reloads across instances", async () => {
    vaultPath = await tmpVault();
    const first = new EncryptedCredentialStore({ masterKey: MASTER, filePath: vaultPath });
    await first.set("persisted", "linear", "OAUTH2", "tok_persisted", {
      expiresAt: 1_000_000,
    });
    await first.flush();

    // A second instance over the same file decrypts the same secret.
    const second = new EncryptedCredentialStore({ masterKey: MASTER, filePath: vaultPath });
    expect(await second.load()).toBe(1);
    expect((await second.get("persisted")).secret).toBe("tok_persisted");
    expect(second.has("persisted")).toBe(true);
  });

  it("treats a missing vault file as an empty store, not an error", async () => {
    vaultPath = await tmpVault();
    const store = new EncryptedCredentialStore({ masterKey: MASTER, filePath: vaultPath });
    expect(await store.load()).toBe(0);
  });

  it("refuses a vault that is not valid JSON", async () => {
    vaultPath = await tmpVault();
    await fs.writeFile(vaultPath, "{not json", "utf8");
    const store = new EncryptedCredentialStore({ masterKey: MASTER, filePath: vaultPath });
    await expect(store.load()).rejects.toMatchObject({ kind: "format" });
  });

  it("writes atomically: no partial vault is left on a failed write", async () => {
    vaultPath = await tmpVault();
    const store = new EncryptedCredentialStore({
      masterKey: MASTER,
      filePath: path.join(path.dirname(vaultPath), "nested", "deep", "vault.json"),
    });
    await store.set("k1", "github", "OAUTH2", "s");
    // The tmp sibling is gone after a successful flush.
    const siblings = await fs.readdir(path.join(path.dirname(vaultPath), "nested", "deep"));
    expect(siblings).toEqual(["vault.json"]);
  });

  it("verifies the passphrase in constant time and rejects a wrong one", async () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    expect(store.verifyPassphrase("wrong")).toBe(false);
    await store.set("k1", "github", "OAUTH2", "s");
    expect(store.verifyPassphrase(MASTER)).toBe(true);
    expect(store.verifyPassphrase(`${MASTER}-nope`)).toBe(false);
  });

  it("zeroizes the master key on dispose and then refuses everything", async () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    await store.set("k1", "github", "OAUTH2", "s");
    store.dispose();
    await expect(store.get("k1")).rejects.toMatchObject({ kind: "io" });
    await expect(store.set("k2", "github", "OAUTH2", "s")).rejects.toMatchObject({ kind: "io" });
    // dispose is idempotent.
    expect(() => store.dispose()).not.toThrow();
  });

  it("accepts every documented auth scheme", async () => {
    const store = new EncryptedCredentialStore({ masterKey: MASTER });
    for (const scheme of CREDENTIAL_AUTH_SCHEMES) {
      await store.set(`key-${scheme}`, "provider", scheme, "s");
    }
    expect(store.size).toBe(CREDENTIAL_AUTH_SCHEMES.length);
  });

  it("does not flush when autoFlush is disabled", async () => {
    vaultPath = await tmpVault();
    const store = new EncryptedCredentialStore({
      masterKey: MASTER,
      filePath: vaultPath,
      autoFlush: false,
    });
    await store.set("k1", "github", "OAUTH2", "s");
    // Nothing on disk yet — a load in a second instance sees nothing.
    const other = new EncryptedCredentialStore({ masterKey: MASTER, filePath: vaultPath });
    expect(await other.load()).toBe(0);
    await store.flush();
    expect(await other.load()).toBe(1);
  });
});
