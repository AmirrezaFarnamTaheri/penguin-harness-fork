const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HPORT = "D:/GitHub/HPORT";
const OUT = path.join(HPORT, "extracted");
fs.mkdirSync(OUT, { recursive: true });

const inv = JSON.parse(fs.readFileSync("hport-inventory.json", "utf8"));
// smallest first; skip anything > 40 MB this pass (giants handled separately)
const todo = inv.archives.filter((a) => a.bytes < 40 * 1e6);
console.log("to extract this pass:", todo.length);

let ok = 0,
  fail = 0;
for (const a of todo) {
  const dest = path.join(OUT, a.name.replace(/\.zip$/, ""));
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    ok++;
    continue;
  }
  try {
    execFileSync("unzip", ["-q", "-o", path.join(HPORT, a.name), "-d", OUT], { stdio: "ignore" });
    ok++;
  } catch (e) {
    fail++;
    console.log("FAIL", a.name, String(e.message).slice(0, 120));
  }
}
console.log("done. ok:", ok, "fail:", fail);
console.log("extracted dirs:", fs.readdirSync(OUT).length);
