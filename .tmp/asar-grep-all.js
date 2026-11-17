const fs = require("node:fs");
const path = require("node:path");
const base = "C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai";
const [term, limitArg, onlyArg] = process.argv.slice(2);
const limit = Number(limitArg || 60);
const only = onlyArg || "";
const out = [];
let total = 0;
function walk(dir, depth) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" && depth > 1) continue;
      walk(full, depth + 1);
      continue;
    }
    if (!/\.(js|mjs|ts|tsx|md)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > 1024 * 1024) continue;
    let text;
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (!text.includes(term)) continue;
    if (only && !full.includes(only)) continue;
    const lines = text.split(/\r?\n/);
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) if (lines[i].includes(term)) hits.push(i);
    out.push("== " + full.replace(base, "") + " hits=" + hits.length + " lines=" + lines.length);
    total += hits.length;
    for (const i of hits.slice(0, Math.max(2, Math.ceil(limit / 6)))) {
      out.push(">" + (i + 1) + ": " + lines[i].slice(0, 300));
    }
  }
}
walk(base, 0);
fs.writeFileSync("D:\\workspace\\HNFlow\\.tmp\\grep-all-out.txt", out.join("\n"));
console.log("total", total);
