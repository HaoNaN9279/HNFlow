// Local trace sink for the live GUI probe. Writes every POST body to trace.log.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const LOG = path.join(__dirname, "trace.log");
fs.writeFileSync(LOG, "");

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    fs.appendFileSync(LOG, body + "\n");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
});

server.listen(38999, "127.0.0.1", () => {
  fs.appendFileSync(LOG, "[server] listening\n");
});
