const fs = require("fs");
const path = require("path");

const ROOT = "D:/GitHub/HPORT/extracted";
const inv = JSON.parse(fs.readFileSync("hport-inventory.json", "utf8"));

// map archive -> extracted dir (handle nested <name>/<name> and skills-main (N) merges)
function resolveDir(base) {
  const direct = path.join(ROOT, base);
  if (!fs.existsSync(direct)) return null;
  const inner = path.join(direct, base);
  if (fs.existsSync(inner) && fs.statSync(inner).isDirectory()) return inner;
  return direct;
}

const extLang = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".rs": "Rust",
  ".go": "Go",
  ".py": "Python",
  ".md": "Markdown",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".css": "CSS",
  ".json": "JSON",
  ".toml": "TOML",
  ".rs?": "Rust",
  ".edn": "Clojure",
  ".clj": "Clojure",
  ".ex": "Elixir",
  ".exs": "Elixir",
};

function scan(dir, depth = 0, acc = { files: 0, byLang: {}, samples: [] }) {
  if (depth > 6 || acc.files > 4000) return acc;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    if (
      e.name === "node_modules" ||
      e.name === ".git" ||
      e.name === "target" ||
      e.name === "dist" ||
      e.name === ".venv" ||
      e.name === "venv" ||
      e.name === "__pycache__"
    )
      continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scan(full, depth + 1, acc);
    else {
      acc.files++;
      const ext = path.extname(e.name).toLowerCase();
      const lang = extLang[ext];
      if (lang) acc.byLang[lang] = (acc.byLang[lang] || 0) + 1;
      if (acc.samples.length < 6 && lang && lang !== "Markdown" && lang !== "JSON") {
        const rel = path.relative(ROOT, full);
        acc.samples.push(rel);
      }
    }
  }
  return acc;
}

const report = [];
for (const a of inv.archives) {
  const base = a.name.replace(/\.zip$/, "");
  const dir = resolveDir(base);
  if (!dir) continue;
  const s = scan(dir);
  const langs = Object.entries(s.byLang).sort((x, y) => y[1] - x[1]);
  report.push({
    archive: a.name,
    tracked: a.tracked,
    extracted_dir: path.relative(ROOT, dir),
    files: s.files,
    top_languages: langs.slice(0, 4).map(([l, n]) => `${l}:${n}`),
    code_samples: s.samples,
  });
}

report.sort((x, y) => y.files - x.files);
fs.writeFileSync("hport-audit.json", JSON.stringify(report, null, 2));
console.log("audited donors:", report.length);
console.log("\n=== donors by file count (top 30) ===");
for (const r of report.slice(0, 30)) {
  console.log(
    `${String(r.files).padStart(6)}  [${r.top_languages.join(", ")}]  ${r.extracted_dir}${r.tracked ? " (tracked)" : " (UNTRACKED)"}`,
  );
}
console.log("\n=== untracked donors (the untouched value), by size of codebase ===");
for (const r of report.filter((x) => !x.tracked).slice(0, 40)) {
  console.log(`${String(r.files).padStart(6)}  [${r.top_languages[0] || "?"}]  ${r.extracted_dir}`);
}
