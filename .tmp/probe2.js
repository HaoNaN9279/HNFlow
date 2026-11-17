const fs = require("node:fs");
const root = "C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\node_modules\\@deepseek-ai";
const dsh = "C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules";
const out = [];
for (const [label, dir] of [["outer", root], ["dsh", dsh]]) {
  try {
    const names = fs.readdirSync(dir);
    out.push("== " + label + " " + dir + " count=" + names.length);
    if (label === "outer") out.push(names.join("\n"));
    else out.push(names.filter((n) => /slot|renderer|client-|store/.test(n)).join("\n"));
  } catch (error) {
    out.push("ERR " + label + ": " + String(error));
  }
}
fs.writeFileSync("D:\\workspace\\HNFlow\\.tmp\\probe2-out.txt", out.join("\n"));
console.log("ok");
