const fs = require("fs");
const prog = JSON.parse(fs.readFileSync("porting_progress.json", "utf8"));
const projects = prog.projects;
const hport = "D:/GitHub/HPORT";
const actual = new Set(fs.readdirSync(hport));
const present = new Set([...actual].filter((f) => f.endsWith(".zip")));
const mapped = new Set(Object.keys(projects));
const man = fs.readFileSync("PORTING_MANIFEST.md", "utf8");
const manNames = new Set([...man.matchAll(/`([^`]+\.zip)`/g)].map((m) => m[1]));

console.log("progress projects:", mapped.size);
console.log("zips on disk:", present.size);
console.log("tracked but MISSING on disk:", [...mapped].filter((f) => !present.has(f)).length);
console.log("on disk but UNTRACKED:", [...present].filter((f) => !mapped.has(f)).length);
console.log(
  "manifest names:",
  manNames.size,
  "| missing on disk:",
  [...manNames].filter((f) => !present.has(f)).length,
);

const miss = [...mapped].filter((f) => !present.has(f)).sort();
console.log("\n=== MISSING (tracked but absent on disk) ===\n  " + miss.slice(0, 40).join("\n  "));
const un = [...present].filter((f) => !mapped.has(f)).sort();
console.log(
  "\n=== UNTRACKED (on disk, not in progress json) ===\n  " + un.slice(0, 40).join("\n  "),
);

const c = {};
for (const p of Object.values(projects)) c[p.status] = (c[p.status] || 0) + 1;
console.log("\nstatus counts:", JSON.stringify(c));
const cl = {};
for (const p of Object.values(projects)) cl[p.classification] = (cl[p.classification] || 0) + 1;
console.log("classification:", JSON.stringify(cl));

// target-file existence audit
const targets = new Set(Object.values(projects).map((p) => p.target_file));
const missingTargets = [...targets].filter((t) => {
  const clean = t.replace(/[/\\]+/g, "/");
  return !fs.existsSync(clean);
});
console.log("\ndistinct target files:", targets.size, "| MISSING targets:", missingTargets.length);
console.log("  " + missingTargets.slice(0, 20).join("\n  "));
