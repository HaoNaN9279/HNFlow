// Offline validation of the hnflow preset's plugin list against the installed
// DSH 0.2.2-rc.3: resolve each module specifier, import it, and validate the
// configured options with that plugin's own Config schema.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const install = 'C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules'
const profile = 'C:\\Users\\HaoNaN\\.dsh\\profiles\\desktop\\node_modules'

const entries = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are an HNFlow agent powered by the {{model}} model.' } },
  { id: 'hnflow', name: 'dsh-hnflow' },
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
  { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: { section: 'You are in plan mode.' } },
  { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
  { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
  { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
  { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
  { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true } },
  { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', toolName: 'subagent_fork' } },
  { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
  { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
]

function locate(pkgName) {
  for (const root of [install, profile]) {
    const dir = path.join(root, pkgName)
    if (existsSync(path.join(dir, 'package.json'))) return dir
  }
  return null
}

function exportTarget(manifest, sub) {
  const exp = manifest.exports
  if (exp === undefined) return null
  if (typeof exp === 'string') return sub === '' ? exp : null
  const keys = Object.keys(exp)
  if (keys.length === 0) return null
  if (typeof exp === 'string') return exp
  const key = sub === '' ? '.' : './' + sub
  const hit = exp[key] ?? (sub === '' ? exp['.'] : undefined)
  if (hit === undefined) return null
  if (typeof hit === 'string') return hit
  return hit.default ?? hit.import ?? hit.require ?? null
}

const report = []
for (const entry of entries) {
  const label = `${entry.id} (${entry.name})`
  const parts = entry.name.split('/')
  const pkgName = entry.name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const sub = entry.name.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/')
  const dir = locate(pkgName)
  if (dir === null) { report.push(`MISSING PACKAGE  ${label}`); continue }
  let manifest
  try { manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch (error) {
    report.push(`NO MANIFEST  ${label}: ${error.message}`); continue
  }
  const target = exportTarget(manifest, sub)
  if (target === null) { report.push(`NO EXPORT  ${label}`); continue }
  const file = path.resolve(dir, target)
  if (!existsSync(file)) { report.push(`MISSING FILE  ${label} -> ${file}`); continue }
  let mod
  try { mod = await import(pathToFileURL(file).href) } catch (error) {
    report.push(`IMPORT FAIL  ${label}: ${error.message}`); continue
  }
  const schema = mod.Config ?? mod.default?.Config ?? mod.default?.default?.Config
  if (schema === undefined) { report.push(`ok (no config schema)  ${label}`); continue }
  if (typeof schema !== 'function') { report.push(`ok (schema not callable)  ${label}`); continue }
  try {
    schema(entry.config ?? {})
    report.push(`ok  ${label}`)
  } catch (error) {
    report.push(`CONFIG FAIL  ${label}: ${error.message}`)
  }
}
console.log(report.join('\n'))
