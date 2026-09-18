const fs = require("fs");
const path = require("path");

const HPORT = "D:/GitHub/HPORT";
const prog = JSON.parse(fs.readFileSync("porting_progress.json", "utf8"));
const tracked = new Set(Object.keys(prog.projects));

const entries = fs
  .readdirSync(HPORT)
  .filter((f) => f.endsWith(".zip"))
  .map((f) => {
    const st = fs.statSync(path.join(HPORT, f));
    return { name: f, bytes: st.size, tracked: tracked.has(f) };
  })
  .sort((a, b) => a.bytes - b.bytes);

const inv = {
  generated_at: new Date().toISOString(),
  source_root: HPORT,
  total_archives: entries.length,
  tracked_in_old_record: entries.filter((e) => e.tracked).length,
  untracked: entries.filter((e) => !e.tracked).length,
  archives: entries,
};
fs.writeFileSync("hport-inventory.json", JSON.stringify(inv, null, 2));

console.log("total archives:", inv.total_archives);
console.log("tracked (old record):", inv.tracked_in_old_record);
console.log("UNTRACKED (never audited):", inv.untracked);
console.log(
  "total compressed size (MB):",
  Math.round(entries.reduce((s, e) => s + e.bytes, 0) / 1e6),
);
console.log("\n=== untracked, smallest-first (the untouched value) ===");
entries
  .filter((e) => !e.tracked)
  .forEach((e) => console.log(`  ${String(Math.round(e.bytes / 1024)).padStart(8)} KB  ${e.name}`));
