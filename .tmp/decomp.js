const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const dir = process.argv[2];
const out = process.argv[3];
const names = fs.readdirSync(dir);
const lines = [];
for (const name of names) {
  if (!name.endsWith(".zstd")) continue;
  const buf = fs.readFileSync(path.join(dir, name));
  let text;
  try {
    text = zlib.zstdDecompressSync(buf).toString("utf8");
  } catch (error) {
    lines.push(`!! ${name}: ${error.message}`);
    continue;
  }
  for (const line of text.split("\n")) {
    if (line.length > 0) lines.push(`${name}\t${line}`);
  }
}
fs.writeFileSync(out, lines.join("\n"), "utf8");
console.log(`${dir}: ${lines.length} rows -> ${out}`);
