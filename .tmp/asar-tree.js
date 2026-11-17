const fs = require("node:fs");
const path = require("node:path");
const base = "C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai";
const target = path.join(base, process.argv[2]);
const out = [];
function walk(dir, depth) {
  if (depth > 3) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(" ".repeat(depth * 2) + entry.name + "/"); walk(full, depth + 1); continue; }
    out.push(" ".repeat(depth * 2) + entry.name + " " + fs.statSync(full).size);
  }
}
walk(target, 0);
fs.writeFileSync("D:\\workspace\\HNFlow\\.tmp\\tree-out.txt", out.join("\n"));
console.log("done", out.length);
