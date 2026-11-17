// Check that every module named by the hnflow preset resolves, and inspect the
// config schema keys the preset passes to each.
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const install = 'C:\\Users\\HaoNaN\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules'
const profile = 'C:\\Users\\HaoNaN\\.dsh\\profiles\\desktop\\node_modules'

const names = [
  '@deepseek-ai/dsh-persona',
  'dsh-hnflow',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-time-context',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-schedule',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-command-goal',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-subagent-control/list-agents',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-workflow-ptc',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-present',
  '@deepseek-ai/dsh-plugin-manager/tools',
  '@deepseek-ai/dsh-plugin-market/tools',
]

const report = []
for (const name of names) {
  const parts = name.split('/')
  const pkgName = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const sub = name.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/')
  const candidates = [install, profile, 'D:\\workspace\\HNFlow\\plugins\\dsh\\node_modules']
  let dir = null
  for (const root of candidates) {
    const p = path.join(root, pkgName)
    if (existsSync(p)) { dir = p; break }
  }
  if (dir === null) { report.push(`MISSING package: ${name}`); continue }
  if (sub === '') { report.push(`ok ${name}`); continue }
  let manifest = null
  try { manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch (e) { report.push(`no manifest: ${name}: ${e.message}`); continue }
  const exp = manifest.exports
  const key = './' + sub
  let found = false
  let detail = ''
  if (typeof exp === 'string') { found = true; detail = 'string export' }
  else if (exp && typeof exp === 'object') {
    if (exp[key] !== undefined) { found = true; detail = JSON.stringify(exp[key]) }
    else if (exp['./*'] !== undefined) { found = true; detail = 'wildcard: ' + JSON.stringify(exp['./*']) }
    else if (Array.isArray(exp) || typeof exp === 'string') { found = true }
  }
  report.push(`${found ? 'ok' : 'NO-SUBPATH'} ${name} ${detail}`)
}
console.log(report.join('\n'))
