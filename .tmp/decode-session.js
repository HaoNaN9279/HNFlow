const z = require('zlib');
const fs = require('fs');

const src = process.argv[2];
const outPath = process.argv[3];
const b = fs.readFileSync(src);

const magic = [];
for (let i = 0; i < b.length - 3; i++) {
  if (b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd) magic.push(i);
}
magic.push(b.length);

function tryDecode(s, e) {
  try {
    const t = z.zstdDecompressSync(b.subarray(s, e)).toString('utf8');
    if (!t.endsWith('\n')) return null;
    const lines = t.split('\n').filter(Boolean);
    const recs = [];
    for (const line of lines) recs.push(JSON.parse(line));
    return { recs, text: t };
  } catch {
    return null;
  }
}

let start = 0;
const records = [];
let guard = 0;
while (start < b.length && guard++ < 10000) {
  let found = false;
  for (const k of magic) {
    if (k <= start) continue;
    const r = tryDecode(start, k);
    if (r) {
      records.push(...r.recs);
      start = k;
      found = true;
      break;
    }
  }
  if (!found) {
    console.error('stuck at', start, 'remaining', b.length - start);
    break;
  }
}

console.error('records', records.length, 'lastSeq', records[records.length - 1].seq);

// Render readable transcript
const out = [];
for (const r of records) {
  const d = r.data || {};
  if (r.type === 'session') out.push(`# SESSION ${r.id} cwd=${r.cwd}`);
  else if (r.type === 'agent/inbox/spliced') {
    for (const m of d.inserted || []) {
      const text = (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      out.push(`\n===== USER (seq ${r.seq}) =====\n${text}`);
    }
  } else if (r.type === 'system/message') {
    // skip giant system prompt
  } else if (r.type === 'agent/message') {
    const m = d.message || {};
    const parts = [];
    for (const c of m.content || []) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'tool-call' || c.type === 'tool_use') parts.push(`[TOOL ${c.name}] ${JSON.stringify(c.arguments || c.input).slice(0, 4000)}`);
    }
    if (parts.length) out.push(`\n===== ASSISTANT (seq ${r.seq}) =====\n${parts.join('\n')}`);
  } else {
    // tool results / logs / state
    const s = JSON.stringify(d);
    if (r.type.includes('tool') || r.type.includes('result') || r.type.includes('log')) {
      out.push(`\n----- ${r.type} (seq ${r.seq}) -----\n${s.slice(0, 4000)}`);
    }
  }
}

fs.writeFileSync(outPath, out.join('\n'));
console.error('wrote', outPath, fs.statSync(outPath).size);
