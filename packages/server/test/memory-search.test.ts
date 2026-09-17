/**
 * Memory search route (GET …/memory/search?q=): a server-side lexical scan of the
 * Agent's topic files — the retrieval primitive the recall simulator should query,
 * rather than a client-side word-overlap estimate. Relevance = matched terms /
 * total terms; snippet = first non-frontmatter line, bounded; the MEMORY.md index
 * file is not a topic and is excluded; non-members see 404.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryScopeDir } from "@prismshadow/penguin-core";
import type { MemorySearchResponse, ProjectCreateResponse } from "../src/api/types.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const WORKSPACE_KEY = "my-app-a81f32c4";
const DATABASE_TOPIC = `---
name: database-rules
description: database conventions for this project
updated_at: 2026-08-07
---

Use PostgreSQL with connection pooling.
`;

const TESTING_TOPIC = `---
name: testing-conventions
description: how tests are run here
updated_at: 2026-08-07
---

- Integration tests talk to a real database.
`;

describe("memory search api", () => {
  let t: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let projectId: string;
  let memoryPath: string;
  let wsDir: string;

  beforeEach(async () => {
    t = await createTestApp();
    const a = await provisionUser(t.app, "owner_s");
    owner = apiClient(t.app, a.cookie);
    const created = (await (
      await owner.post("/api/projects", { projectId: "owner_s-search", name: "search project" })
    ).json()) as ProjectCreateResponse;
    projectId = created.project.projectId;
    memoryPath = `/api/projects/${projectId}/agents/default_agent/memory`;
    wsDir = memoryScopeDir(t.root, projectId, "default_agent", WORKSPACE_KEY);
    await fs.mkdir(wsDir, { recursive: true });
    await fs.writeFile(path.join(wsDir, ".workspace"), "/home/dev/my-app\n", "utf8");
    await fs.writeFile(path.join(wsDir, "database-rules.md"), DATABASE_TOPIC, "utf8");
    await fs.writeFile(path.join(wsDir, "testing-conventions.md"), TESTING_TOPIC, "utf8");
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("matches topics across scopes with per-term relevance and a snippet", async () => {
    const body = (await (
      await owner.get(`${memoryPath}/search?q=database%20tests`)
    ).json()) as MemorySearchResponse;
    expect(body.query).toBe("database tests");
    expect(body.results).toHaveLength(2);
    // "database" hits the database file only (0.5); "tests" appears in the testing topic's
    // frontmatter and body, so it matches both terms (1).
    const testing = body.results.find((r) => r.fileName === "testing-conventions.md");
    expect(testing).toMatchObject({ scopeKey: WORKSPACE_KEY, relevance: 1 });
    expect(testing!.snippet.length).toBeGreaterThan(0);
    expect(testing!.tokens).toBeGreaterThan(0);
    const db = body.results.find((r) => r.fileName === "database-rules.md");
    expect(db!.relevance).toBe(0.5);
  });

  it("excludes the MEMORY.md index file from matches", async () => {
    await fs.writeFile(
      path.join(wsDir, "MEMORY.md"),
      "- [x](x.md) — zzzindexonlytoken lives here\n",
      "utf8",
    );
    const body = (await (
      await owner.get(`${memoryPath}/search?q=zzzindexonlytoken`)
    ).json()) as MemorySearchResponse;
    expect(body.results).toHaveLength(0);
  });

  it("rejects an empty query with 400 and hides search from non-members", async () => {
    const empty = await owner.get(`${memoryPath}/search?q=%20`);
    expect(empty.status).toBe(400);
    const outsider = await provisionUser(t.app, "outsider_s");
    const other = apiClient(t.app, outsider.cookie);
    const denied = await other.get(`${memoryPath}/search?q=database`);
    expect(denied.status).toBe(404);
  });
});
