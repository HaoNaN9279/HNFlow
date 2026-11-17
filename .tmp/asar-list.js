const fs = require("node:fs");
const lines = [];
const roots = [
  "C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai",
  "C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh",
];
for (const root of roots) {
  lines.push("== " + root + " exists=" + fs.existsSync(root));
  if (fs.existsSync(root)) {
    const names = fs.readdirSync(root);
    lines.push("count=" + names.length);
    lines.push(names.join("\n"));
  }
}
fs.writeFileSync("D:\\workspace\\HNFlow\\.tmp\\asar-list-out.txt", lines.join("\n"));
