/**
 * The named key fleet, end to end over HTTP: naming a key, the 409 on a name already taken in
 * that fleet, the optional label, and the promise that no read which returns a name ever
 * returns the key.
 *
 * The last one is the reason this feature is careful about where the secret lives. The key is
 * write-only at rest in `.project_config.toml`; naming a key must not become a second way to
 * read one. So the secret-assertion cases below walk every read that returns a name and
 * search the whole response body for the plaintext, rather than asserting on the fields
 * happen to be absent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import type { ProjectCreateResponse } from "../src/api/types.js";
import type { ModelKeyNameDto } from "../src/services/model-key-names.js";
import type { NamedKeyHealthReport } from "../src/http/routes/models.js";
import { maskApiKey as fleetMask } from "@prismshadow/penguin-core";

/** Three keys in one pool, so "which one is prod" has a real answer to be wrong about. */
const KEY_A = "sk-proj-9f2a1b2c3d4e5f6g7h8i9j0k";
const KEY_B = "sk-proj-3b715c8d9e0f1a2b3c4d5e6f";
const KEY_C = "sk-proj-77aa88bb99cc00dd11ee22ff";
const POOL = `${KEY_A}, ${KEY_B}, ${KEY_C}`;

interface NamedKeysResponse {
  keys: ModelKeyNameDto[];
}

/** Every string anywhere in a parsed JSON body, so a secret cannot hide in a nested field. */
function everyString(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) everyString(v, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) everyString(v, out);
  }
  return out;
}

describe("named key fleets", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  let projectId: string;

  beforeEach(async () => {
    t = await createTestApp();
    const { cookie } = await provisionUser(t.app, "alice");
    api = apiClient(t.app, cookie);
    const created = (await (
      await api.post("/api/projects", { projectId: "alice-keys_named", name: "Named Keys" })
    ).json()) as ProjectCreateResponse;
    projectId = created.project.projectId;
    const put = await api.put(`/api/projects/${projectId}/models`, {
      defaultModel: { provider: "deepseek", modelId: "deepseek-chat" },
      models: [
        { provider: "deepseek", modelId: "deepseek-chat", apiKey: POOL },
        { provider: "deepseek", modelId: "deepseek-v4", apiKey: KEY_A },
      ],
    });
    expect(put.status).toBe(200);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  /** Names a key by the mask the health report shows, and returns the route's answer. */
  async function name(maskedKey: string, name: string, label?: string) {
    return api.put(`/api/projects/${projectId}/models/keys`, {
      provider: "deepseek",
      modelId: "deepseek-chat",
      maskedKey,
      name,
      ...(label === undefined ? {} : { label }),
    });
  }

  async function health() {
    const res = await api.get(
      `/api/projects/${projectId}/models/keys/health?provider=deepseek&modelId=deepseek-chat`,
    );
    return (await res.json()) as NamedKeyHealthReport;
  }

  it("a name round-trips: it comes back on the key it was given to, and nowhere else", async () => {
    const before = await health();
    expect(before.keys).toHaveLength(3);
    const firstMask = before.keys[0]!.maskedKey;

    const res = await name(firstMask, "staging", "shared team pool — do not rotate");
    expect(res.status).toBe(200);
    const saved = (await res.json()) as ModelKeyNameDto;
    expect(saved.name).toBe("staging");
    expect(saved.label).toBe("shared team pool — do not rotate");
    expect(saved.provider).toBe("deepseek");
    expect(saved.modelId).toBe("deepseek-chat");
    expect(saved.orphaned).toBe(false);
    // The handle is a short digest-derived id, not the key and not a mask of it.
    expect(saved.keyId).toMatch(/^k_[0-9a-f]{12}$/);

    const after = await health();
    const named = after.keys.filter((k) => k.name !== undefined);
    expect(named).toHaveLength(1);
    expect(named[0]!.maskedKey).toBe(firstMask);
    expect(named[0]!.name).toBe("staging");
    expect(named[0]!.label).toBe("shared team pool — do not rotate");
    expect(named[0]!.keyId).toBe(saved.keyId);
    // The two keys nobody named are untouched — no invented "Key 1", no empty-string name.
    expect(after.keys.filter((k) => k.maskedKey !== firstMask)).toHaveLength(2);
    for (const key of after.keys.filter((k) => k.maskedKey !== firstMask)) {
      expect(key.name).toBeUndefined();
      expect(key.label).toBeUndefined();
    }

    // And through the list the fleet view joins against.
    const list = await api.get(`/api/projects/${projectId}/models/keys`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as NamedKeysResponse;
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]!.name).toBe("staging");
    // The list answers with the FLEET mask, the string GET /api/cockpit/keys prints for this
    // key, because that is the surface the fleet view joins against. It is deliberately not the
    // narrower mask keys/health prints: a caller joins on what its own surface shows, and a
    // join on a value it was never handed is how a name lands on the wrong key.
    expect(listed.keys[0]!.maskedKey).toBe(fleetMask(KEY_A));
  });

  it("the same key under a different model is a different key, with its own name", async () => {
    const other = await api.get(
      `/api/projects/${projectId}/models/keys/health?provider=deepseek&modelId=deepseek-v4`,
    );
    const otherReport = (await other.json()) as NamedKeyHealthReport;
    // The very same secret is configured on two models. The digest is fleet-scoped, so the
    // two get different handles and the same name on both is two keys, not a collision.
    const res = await api.put(`/api/projects/${projectId}/models/keys`, {
      provider: "deepseek",
      modelId: "deepseek-v4",
      maskedKey: otherReport.keys[0]!.maskedKey,
      name: "prod",
    });
    expect(res.status).toBe(200);
    const v4 = (await res.json()) as ModelKeyNameDto;

    const firstMask = (await health()).keys[0]!.maskedKey;
    const same = await name(firstMask, "prod");
    expect(same.status).toBe(200);
    const chat = (await same.json()) as ModelKeyNameDto;

    expect(v4.keyId).not.toBe(chat.keyId);
    expect(v4.name).toBe("prod");
    expect(chat.name).toBe("prod");
  });

  it("a name already taken in the same fleet is a 409, and the first name survives it", async () => {
    const masks = (await health()).keys.map((k) => k.maskedKey);
    const first = await name(masks[0]!, "prod", "the one we bill with");
    expect(first.status).toBe(200);

    const clash = await name(masks[1]!, "prod", "a different key entirely");
    expect(clash.status).toBe(409);
    const body = (await clash.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("key_name_taken");
    // The message has to say WHICH pool and WHICH name, not merely that it failed.
    expect(body.error.message).toContain("prod");
    expect(body.error.message).toContain("deepseek");

    // The refusal is not a no-op that merely reports itself: the second key is still unnamed
    // and the first one is exactly as it was, label included.
    const after = await health();
    const named = after.keys.filter((k) => k.name !== undefined);
    expect(named).toHaveLength(1);
    expect(named[0]!.maskedKey).toBe(masks[0]);
    expect(named[0]!.label).toBe("the one we bill with");
  });

  it("a name differing only in case is still a collision — one fleet, one spelling", async () => {
    const masks = (await health()).keys.map((k) => k.maskedKey);
    expect((await name(masks[0]!, "prod")).status).toBe(200);
    const clash = await name(masks[1]!, "Prod");
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: { code: string } }).error.code).toBe("key_name_taken");
  });

  it("renaming a key to a free name frees the name it had", async () => {
    const masks = (await health()).keys.map((k) => k.maskedKey);
    await name(masks[0]!, "staging");
    expect((await name(masks[1]!, "staging")).status).toBe(409);

    // Move the first key off "staging"; the second may now take it.
    expect((await name(masks[0]!, "prod")).status).toBe(200);
    const taken = await name(masks[1]!, "staging");
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as ModelKeyNameDto).name).toBe("staging");
  });

  it("a rename to the name it already has is accepted, not a self-collision", async () => {
    const mask = (await health()).keys[0]!.maskedKey;
    await name(mask, "prod", "first label");
    const again = await name(mask, "prod", "second label");
    expect(again.status).toBe(200);
    const saved = (await again.json()) as ModelKeyNameDto;
    expect(saved.label).toBe("second label");
    const list = (await (
      await api.get(`/api/projects/${projectId}/models/keys`)
    ).json()) as NamedKeysResponse;
    expect(list.keys).toHaveLength(1);
  });

  it("the name is required: empty, whitespace-only, and over-long are all 400s", async () => {
    const mask = (await health()).keys[0]!.maskedKey;
    for (const bad of ["", "   ", "\t\n", "x".repeat(65)]) {
      const res = await name(mask, bad);
      expect(res.status, `name ${JSON.stringify(bad)} must be refused`).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("bad_request");
    }
    // A name at the limit is fine, and nothing was written by any of the refusals.
    expect((await name(mask, "x".repeat(64))).status).toBe(200);
    const list = (await (
      await api.get(`/api/projects/${projectId}/models/keys`)
    ).json()) as NamedKeysResponse;
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0]!.name).toBe("x".repeat(64));
  });

  it("a missing name is a 400, and a name that is not text is a 400", async () => {
    const mask = (await health()).keys[0]!.maskedKey;
    const missing = await api.put(`/api/projects/${projectId}/models/keys`, {
      provider: "deepseek",
      modelId: "deepseek-chat",
      maskedKey: mask,
    });
    expect(missing.status).toBe(400);
    for (const bad of [42, null, { prod: true }, ["prod"]]) {
      const res = await api.put(`/api/projects/${projectId}/models/keys`, {
        provider: "deepseek",
        modelId: "deepseek-chat",
        maskedKey: mask,
        name: bad,
      });
      expect(res.status, `name ${JSON.stringify(bad)} must be refused`).toBe(400);
    }
  });

  it("a name with a control character or a zero-width mark is a 400, not a silent strip", async () => {
    const mask = (await health()).keys[0]!.maskedKey;
    // Written as escapes, not literals: a real control character in a source file is
    // invisible in review and easy to mangle in transit, and this case is exactly the
    // one where the byte has to be the byte under test.
    for (const bad of [
      "pro\nd",
      "a\tb",
      "a\rb",
      "prod\u0000",
      "prod\u200b",
      "a\u200db",
      "prod\u202e",
    ]) {
      const res = await name(mask, bad);
      expect(res.status, `name ${JSON.stringify(bad)} must be refused`).toBe(400);
    }
  });

  it("the label is optional, free text, and bounded at 500 characters", async () => {
    const keys = (await health()).keys;
    // Absent: a name with no label at all.
    expect((await name(keys[0]!.maskedKey, "prod")).status).toBe(200);
    let list = (await (
      await api.get(`/api/projects/${projectId}/models/keys`)
    ).json()) as NamedKeysResponse;
    expect(list.keys[0]!.label).toBeUndefined();

    // An empty or whitespace-only label is "no label", not a label that happens to be blank.
    expect((await name(keys[0]!.maskedKey, "prod", "   ")).status).toBe(200);
    list = (await (
      await api.get(`/api/projects/${projectId}/models/keys`)
    ).json()) as NamedKeysResponse;
    expect(list.keys[0]!.label).toBeUndefined();

    // Free text: punctuation, an em dash, a language the user writes in, a newline.
    const messy = "shared team pool — do not rotate\n轮换前请确认 · не трогать";
    expect((await name(keys[0]!.maskedKey, "prod", messy)).status).toBe(200);
    list = (await (
      await api.get(`/api/projects/${projectId}/models/keys`)
    ).json()) as NamedKeysResponse;
    expect(list.keys[0]!.label).toBe(messy);

    // Bounded, on both sides: 500 is accepted, 501 is not.
    expect((await name(keys[1]!.maskedKey, "backup", "l".repeat(500))).status).toBe(200);
    const over = await name(keys[1]!.maskedKey, "backup", "l".repeat(501));
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: { message: string } }).error.message).toContain("500");
    // The refused over-long label left the accepted one in place.
    const after = await health();
    expect(after.keys.find((k) => k.maskedKey === keys[1]!.maskedKey)!.label).toBe("l".repeat(500));
  });

  it("a mask that names no key in the pool is a 404, and it writes nothing", async () => {
    const res = await name("sk-nope...0000", "prod");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "deepseek",
    );
    const list = (await (
      await api.get(`/api/projects/${projectId}/models/keys`)
    ).json()) as NamedKeysResponse;
    expect(list.keys).toHaveLength(0);
  });

  it("naming a pool that is not configured is a 404 rather than an empty success", async () => {
    const res = await api.put(`/api/projects/${projectId}/models/keys`, {
      provider: "openai",
      modelId: "gpt-4o",
      maskedKey: "sk-...1234",
      name: "prod",
    });
    expect(res.status).toBe(404);
  });

  it("a name whose key is gone is reported orphaned, not silently dropped", async () => {
    const mask = (await health()).keys[0]!.maskedKey;
    await name(mask, "prod");
    // Rotate the key: same model, one fewer key. The name was given to a key that no longer
    // exists, and the honest answer is "that key is gone" — not a vanished row.
    await api.put(`/api/projects/${projectId}/models`, {
      defaultModel: { provider: "deepseek", modelId: "deepseek-chat" },
      models: [
        { provider: "deepseek", modelId: "deepseek-chat", apiKey: `${KEY_B}, ${KEY_C}` },
        { provider: "deepseek", modelId: "deepseek-v4", apiKey: KEY_A },
      ],
    });
    const list = (await (
      await api.get(`/api/projects/${projectId}/models/keys`)
    ).json()) as NamedKeysResponse;
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0]!.name).toBe("prod");
    expect(list.keys[0]!.orphaned).toBe(true);
    expect(list.keys[0]!.maskedKey).toBeUndefined();
    // And it is gone from the health report, because the report lists the keys that are there.
    const after = await health();
    expect(after.keys.filter((k) => k.name !== undefined)).toHaveLength(0);
  });

  it("DELETE forgets the name and 404s a second time, leaving the key itself in place", async () => {
    const mask = (await health()).keys[0]!.maskedKey;
    const saved = (await (await name(mask, "prod", "temporary")).json()) as ModelKeyNameDto;

    const del = await api.delete(`/api/projects/${projectId}/models/keys/${saved.keyId}`);
    expect(del.status).toBe(200);
    const again = await api.delete(`/api/projects/${projectId}/models/keys/${saved.keyId}`);
    expect(again.status).toBe(404);

    // The KEY survives: the pool still reports three keys, one of them unnamed again.
    const after = await health();
    expect(after.keys).toHaveLength(3);
    const restored = after.keys.find((k) => k.maskedKey === mask)!;
    expect(restored.name).toBeUndefined();
    expect(restored.status).toBe("healthy");
    // And the name it freed is available again.
    expect((await name(mask, "prod")).status).toBe(200);
  });

  it("a key id from another Project resolves to nothing", async () => {
    const other = await api.post("/api/projects", {
      projectId: "alice-keys_other",
      name: "Other",
    });
    const otherProject = ((await other.json()) as ProjectCreateResponse).project.projectId;
    const saved = (await (
      await name((await health()).keys[0]!.maskedKey, "prod")
    ).json()) as ModelKeyNameDto;
    const res = await api.delete(`/api/projects/${otherProject}/models/keys/${saved.keyId}`);
    expect(res.status).toBe(404);
    // Still named in the Project it belongs to.
    const list = (await (
      await api.get(`/api/projects/${projectId}/models/keys`)
    ).json()) as NamedKeysResponse;
    expect(list.keys).toHaveLength(1);
  });

  /**
   * The write-only promise, checked the only way that means anything: every read that
   * returns a name is searched, string by string, for the plaintext of every key in the pool.
   * Asserting "the response has no apiKey field" would pass just as well if the secret were
   * smuggled into `label`, into the masked string, or into an error message.
   */
  it("no read that returns a name returns the key", async () => {
    const keys = (await health()).keys;
    await name(keys[0]!.maskedKey, "prod", "the one we bill with");
    await name(keys[1]!.maskedKey, "staging");

    const reads: Array<[string, () => Response | Promise<Response>]> = [
      ["GET /models/keys", () => api.get(`/api/projects/${projectId}/models/keys`)],
      [
        "GET /models/keys/health (one pool)",
        () =>
          api.get(
            `/api/projects/${projectId}/models/keys/health?provider=deepseek&modelId=deepseek-chat`,
          ),
      ],
      [
        "GET /models/keys/health (all pools)",
        () => api.get(`/api/projects/${projectId}/models/keys/health`),
      ],
      [
        "GET /models/keys/health (by modelRef)",
        () =>
          api.get(
            `/api/projects/${projectId}/models/keys/health?modelRef=deepseek%2Fdeepseek-chat`,
          ),
      ],
      [
        "PUT /models/keys (the rename answer)",
        () => name(keys[2]!.maskedKey, "spare", "kept cold"),
      ],
      ["GET /models (the whole table)", () => api.get(`/api/projects/${projectId}/models`)],
    ];

    for (const [label, run] of reads) {
      const res = await run();
      expect(res.status, `${label} must answer 200`).toBe(200);
      const raw = await res.text();
      for (const secret of [KEY_A, KEY_B, KEY_C]) {
        expect(raw, `${label} must not contain the key`).not.toContain(secret);
        // Also not a prefix long enough to be the key with a suffix cut off.
        expect(raw, `${label} must not contain a 12-character run of the key`).not.toContain(
          secret.slice(0, 12),
        );
      }
    }
  });

  it("the list route's answer is made of annotations only — no key, no key-shaped field", async () => {
    const mask = (await health()).keys[0]!.maskedKey;
    await name(mask, "prod");
    const body = (await (
      await api.get(`/api/projects/${projectId}/models/keys`)
    ).json()) as NamedKeysResponse;
    expect(Object.keys(body).sort()).toEqual(["keys"]);
    // Both masks and nothing else: `maskedKey` is what the fleet report prints, `rowMask` what
    // the models table prints, and both are already on screen for this key to this audience.
    expect(Object.keys(body.keys[0]!).sort()).toEqual([
      "createdAt",
      "keyId",
      "maskedKey",
      "modelId",
      "name",
      "orphaned",
      "provider",
      "rowMask",
      "updatedAt",
    ]);
    expect(everyString(body).join(" ")).not.toContain(KEY_A);
  });

  it("writes are the owner's; any member may read", async () => {
    const mask = (await health()).keys[0]!.maskedKey;
    expect((await name(mask, "prod")).status).toBe(200);

    // A second user, added to the Project but not owning it.
    const { cookie: memberCookie } = await provisionUser(t.app, "bob");
    const member = apiClient(t.app, memberCookie);
    await api.post(`/api/projects/${projectId}/members`, { userId: "bob" });

    const read = await member.get(`/api/projects/${projectId}/models/keys`);
    expect(read.status).toBe(200);
    const healthRead = await member.get(
      `/api/projects/${projectId}/models/keys/health?provider=deepseek&modelId=deepseek-chat`,
    );
    expect(healthRead.status).toBe(200);

    const write = await member.put(`/api/projects/${projectId}/models/keys`, {
      provider: "deepseek",
      modelId: "deepseek-chat",
      maskedKey: mask,
      name: "bobs-key",
    });
    expect(write.status).toBe(403);
    const del = await member.delete(`/api/projects/${projectId}/models/keys/k_0123456789ab`);
    expect(del.status).toBe(403);

    // Unauthenticated is refused everywhere too.
    const none = apiClient(t.app, "");
    expect((await none.get(`/api/projects/${projectId}/models/keys`)).status).toBe(401);
    expect((await none.put(`/api/projects/${projectId}/models/keys`, { name: "x" })).status).toBe(
      401,
    );
    expect(
      (await none.delete(`/api/projects/${projectId}/models/keys/k_0123456789ab`)).status,
    ).toBe(401);
  });

  it("a fleet with no keys at all answers an empty list rather than an error", async () => {
    const created = await api.post("/api/projects", { projectId: "alice-keys_bare", name: "Bare" });
    const bare = ((await created.json()) as ProjectCreateResponse).project.projectId;
    const res = await api.get(`/api/projects/${bare}/models/keys`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as NamedKeysResponse).keys).toEqual([]);
  });
});
