const fs = require("node:fs");
const root = "C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\node_modules\\@deepseek-ai";
fs.writeFileSync("D:\\workspace\\HNFlow\\.tmp\\probe-out.txt", [
  "argv=" + JSON.stringify(process.argv) + "\n",
  "versions=" + JSON.stringify(process.versions.electron) + "\n",
  "existsRoot=" + fs.existsSync(root) + "\n",
  "existsAsar=" + fs.existsSync("C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar") + "\n",
  "names=" + (fs.existsSync(root) ? fs.readdirSync(root).length : -1) + "\n",
].join(""));
console.log("hello-stdout");
