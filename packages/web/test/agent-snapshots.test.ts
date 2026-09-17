import { describe, expect, it } from "vitest";
import { toSnapshotVersionInfo } from "../src/features/snapshots/snapshots-page";
import type { AgentSnapshotVersion, AgentSnapshotsResponse } from "@prismshadow/penguin-server/api";

const response: AgentSnapshotsResponse = {
  currentVersion: 2,
  snapshots: [
    {
      version: 1,
      fileName: "v1.tar.gz",
      sizeBytes: 1024,
      mtimeMs: 1700000000000,
      isCurrent: false,
    },
    { version: 2, fileName: "v2.tar.gz", sizeBytes: 2048, mtimeMs: 1700000600000, isCurrent: true },
  ],
};

describe("live snapshot response mapping", () => {
  it("maps archive entries to timeline versions with current flagged", () => {
    const versions = toSnapshotVersionInfo(response);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      version: 1,
      isCurrent: false,
      label: "v1.tar.gz",
      timestamp: 1700000000000,
    });
    expect(versions[1]).toMatchObject({ version: 2, isCurrent: true });
    expect(versions[1]!.uncompressedSizeBytes).toBe(2048);
  });

  it("falls back to the highest version when the API reports no current snapshot", () => {
    const versions = toSnapshotVersionInfo({ currentVersion: 0, snapshots: response.snapshots });
    expect(versions.find((v) => v.version === 2)?.isCurrent).toBe(true);
    expect(versions.find((v) => v.version === 1)?.isCurrent).toBe(false);
  });
});
