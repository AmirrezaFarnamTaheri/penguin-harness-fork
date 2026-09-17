/** T33: pin the existing HandbookPage's real endpoint wrappers, not a second editor. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../src/api/endpoints";
import { ApiError } from "../src/api/client";

const projectId = "editor-project";
const orgId = "acme";
const base = "/api/projects/editor-project/organizations/acme/handbook";
const documentPath = "decisions/hiring-plan.md";
const markdown =
  "# Hiring plan\n\n- Keep **review** mandatory.\n- 团队手册\n\n```ts\nconst approved = true;\n```\n";

afterEach(() => vi.restoreAllMocks());

describe("existing handbook editor API", () => {
  it("saves the exact Markdown to the selected nested document, not the index", async () => {
    const response = { path: documentPath, content: markdown };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(response));

    expect(await api.putOrgHandbookFile(projectId, orgId, documentPath, markdown)).toEqual(
      response,
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${base}/files/${documentPath}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: markdown }),
    });
  });

  it("loads the document listing and selected content through the file API", async () => {
    const files = [{ path: documentPath, size: 120, updatedAt: "2026-09-17T00:00:00.000Z" }];
    const response = { path: documentPath, content: markdown };
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ files }))
      .mockResolvedValueOnce(Response.json(response));

    expect(await api.listOrgHandbookFiles(projectId, orgId)).toEqual({ files });
    expect(await api.getOrgHandbookFile(projectId, orgId, documentPath)).toEqual(response);
    expect(fetch).toHaveBeenNthCalledWith(1, `${base}/files`, {
      method: "GET",
      credentials: "same-origin",
    });
    expect(fetch).toHaveBeenNthCalledWith(2, `${base}/files/${documentPath}`, {
      method: "GET",
      credentials: "same-origin",
    });
  });

  it("allows clearing a document rather than dropping an empty save body", async () => {
    const response = { path: "README.md", content: "" };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(response));
    expect(await api.putOrgHandbookFile(projectId, orgId, "README.md", "")).toEqual(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${base}/files/README.md`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
  });

  it("propagates a rejected save as ApiError rather than claiming it was saved", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          error: { code: "company_mode_off", message: "Company mode is disabled" },
        },
        { status: 404 },
      ),
    );
    const save = api.putOrgHandbookFile(projectId, orgId, documentPath, markdown);
    await expect(save).rejects.toBeInstanceOf(ApiError);
    await expect(save).rejects.toMatchObject({ status: 404, code: "company_mode_off" });
  });
});
