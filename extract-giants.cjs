const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HPORT = "D:/GitHub/HPORT";
const OUT = path.join(HPORT, "extracted");
const inv = JSON.parse(fs.readFileSync("hport-inventory.json", "utf8"));
const giants = inv.archives.filter((a) => a.bytes >= 40 * 1e6);
console.log("giants:", giants.length);
for (const a of giants) {
  const dest = path.join(OUT, a.name.replace(/\.zip$/, ""));
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    console.log("skip (exists):", a.name);
    continue;
  }
  const t0 = Date.now();
  try {
    execFileSync("unzip", ["-q", "-o", path.join(HPORT, a.name), "-d", OUT], { stdio: "ignore" });
    console.log(`ok ${a.name} (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (e) {
    console.log("FAIL", a.name, String(e.message).slice(0, 200));
  }
}
console.log("ALL DONE. dirs:", fs.readdirSync(OUT).length);
