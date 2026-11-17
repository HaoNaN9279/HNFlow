const fs = require("node:fs");
const path = require("node:path");
const root = "C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules";
const hits = [];
function walk(dir, depth) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "ui-slots") hits.push(path.join(dir, entry.name));
    if (entry.name.startsWith("@") || entry.name.startsWith("dsh")) walk(path.join(dir, entry.name), depth + 1);
  }
}
walk(root, 0);
fs.writeFileSync("D:\\workspace\\HNFlow\\.tmp\\probe4-out.txt", hits.join("\n"));
console.log("hits", hits.length);
