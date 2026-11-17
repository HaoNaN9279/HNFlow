const fs = require("node:fs");
const path = require("node:path");
const base = "C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai";
const [pkg, term, limitArg, contextArg] = process.argv.slice(2);
const limit = Number(limitArg || 40);
const context = Number(contextArg || 0);
const root = path.join(base, pkg);
const out = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(js|mjs|cjs|json|md|ts)$/.test(entry.name)) continue;
    const size = fs.statSync(full).size;
    if (size > 2 * 1024 * 1024) { out.push("SKIP(big) " + full + " " + size); continue; }
    const text = fs.readFileSync(full, "utf8");
    const lines = text.split(/\r?\n/);
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(term)) hits.push({ i, line: lines[i] });
    }
    if (hits.length === 0) continue;
    out.push("== " + full + " hits=" + hits.length + " lines=" + lines.length);
    for (const hit of hits.slice(0, Math.ceil(limit / Math.max(1, hits.length) ) + 3)) {
      const from = Math.max(0, hit.i - context);
      const to = Math.min(lines.length - 1, hit.i + context);
      for (let j = from; j <= to; j += 1) {
        out.push((j === hit.i ? ">" : " ") + (j + 1) + ": " + lines[j].slice(0, 400));
      }
    }
  }
}
walk(root);
fs.writeFileSync("D:\\workspace\\HNFlow\\.tmp\\grep-out.txt", out.join("\n"));
console.log("done", out.length);
