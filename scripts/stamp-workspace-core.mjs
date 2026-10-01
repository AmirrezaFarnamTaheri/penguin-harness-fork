import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCoreSentinel, SENTINEL_FILE } from "./workspace-core-sentinel.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(
  path.join(root, "packages/core", SENTINEL_FILE),
  `${JSON.stringify(createCoreSentinel(root), null, 2)}\n`,
);
