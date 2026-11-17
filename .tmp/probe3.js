const fs = require("node:fs");
const base = "C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai";
const out = [];
for (const name of ["dsh-client-ui-slots", "dsh-client-store", "dsh-client-ui-primitives", "dsh-client-ui-renderer", "dsh-client-modules"]) {
  const dir = base + "\\" + name;
  out.push(name + " exists=" + fs.existsSync(dir));
  if (fs.existsSync(dir)) out.push(fs.readdirSync(dir).join(", "));
}
fs.writeFileSync("D:\\workspace\\HNFlow\\.tmp\\probe3-out.txt", out.join("\n"));
console.log("ok");
