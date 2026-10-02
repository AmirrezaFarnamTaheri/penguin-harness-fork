import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkDocClaims } from "./check-doc-claims.mjs";

test("same-package runtime calls pass; unused imports and broken evidence fail", () => {
  const root = mkdtempSync(path.join(tmpdir(), "penguin-doc-claims-"));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  try {
    write("tsup.config.ts", 'export default { entry: ["src/main.ts"] };');
    write("src/main.ts", 'import { feature } from "./feature.js"; feature();');
    write("src/feature.ts", "export function feature() {}");
    write("docs/proof.md", "# Runtime proof\n");
    const ledger = {
      schemaVersion: 1,
      claims: [
        {
          id: "same-package",
          status: "Shipped",
          implementation: "src/feature.ts",
          links: ["docs/proof.md#runtime-proof"],
          evidence: {
            kind: "runtime-chain",
            entryConfig: "tsup.config.ts",
            chain: ["src/main.ts", "src/feature.ts"],
            symbol: "feature",
          },
        },
      ],
    };
    write("docs/status-ledger.json", JSON.stringify(ledger, null, 2));
    assert.equal(checkDocClaims(root).ok, true);
    write("src/main.ts", 'import { feature } from "./feature.js";');
    const unused = checkDocClaims(root);
    assert.equal(unused.ok, false);
    assert.match(
      unused.issues[0],
      /docs\/status-ledger.json:\d+: same-package: consumer never calls/,
    );
    write(
      "src/main.ts",
      'import { feature } from "./feature.js"; function unrelated(feature: () => void) { feature(); }',
    );
    assert.match(checkDocClaims(root).issues[0], /consumer never calls/);
    write("src/main.ts", 'import { feature } from "./feature.js"; feature();');
    write("src/feature.ts", "export function renamed() {}");
    assert.match(checkDocClaims(root).issues[0], /implementation does not export feature/);
    write("src/feature.ts", "export function feature() {}");
    ledger.claims[0].status = "Experimental/unconsumed";
    ledger.claims[0].reason = "Exported, awaiting integration.";
    write("docs/status-ledger.json", JSON.stringify(ledger));
    assert.equal(checkDocClaims(root).ok, true);
    ledger.claims[0].links = ["docs/proof.md#missing"];
    write("docs/status-ledger.json", JSON.stringify(ledger));
    assert.match(checkDocClaims(root).issues[0], /missing evidence anchor/);
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
