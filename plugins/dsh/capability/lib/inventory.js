/**
 * Session inventory.
 *
 * The inventory explains what one session loads at one working directory: the
 * same plan objects the injection path consumes, in the same order, with the
 * rules decision delegated to `planRules`. It reads content files only to
 * report sizes, summaries and (on demand) full text; it never mutates a plan,
 * never runs a hook and never writes a file.
 *
 * Item order inside a section is the order the model actually receives:
 * persona, skill catalog, commands, MCP servers, the rules message, then the
 * interface-only rosters.
 */

import { readFile } from 'node:fs/promises'

import { INSTRUCTION_SECTION_TITLE, hostInstructions } from './instructions.js'
import { normalizePath, planRules, stripFrontmatter } from './rules.js'

export const INVENTORY_SCHEMA_VERSION = 1
const SUMMARY_LIMIT = 200
const SECTION_TITLES = {
  'agents-md': INSTRUCTION_SECTION_TITLE,
  persona: 'Agent persona',
  skills: 'Skills',
  commands: 'Commands',
  mcp: 'MCP servers',
  rules: 'Rules',
  'rules-skipped': 'Rules not loaded at this path',
  agents: 'Agent roster (interface only)',
}

/**
 * Narrow an arbitrary value to a plain record.
 * @param {unknown} value - candidate value.
 * @returns {Record<string, any>} the value when it is an object, else an empty record.
 */
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * Narrow an arbitrary value to an array.
 * @param {unknown} value - candidate value.
 * @returns {any[]} the value when it is an array, else an empty array.
 */
function list(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Byte length of a string as UTF-8.
 * @param {string} text - text to measure.
 * @returns {number} byte length.
 */
function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/**
 * First meaningful line, used when no description exists.
 * @param {string} text - body text.
 * @param {string} [fallback] - text to use when the body is empty.
 * @returns {string} at most SUMMARY_LIMIT characters.
 */
function summarize(text, fallback = '') {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim().replace(/^#+/u, '').trim()
    if (trimmed.length > 0) return trimmed.slice(0, SUMMARY_LIMIT)
  }
  return String(fallback ?? '').slice(0, SUMMARY_LIMIT)
}

/**
 * Wire item shared by every section.
 * @param {Record<string, any>} fields - item fields.
 * @returns {Record<string, any>} item with stable key order.
 */
function item(fields) {
  return {
    kind: fields.kind,
    id: String(fields.id ?? fields.name ?? ''),
    name: String(fields.name ?? ''),
    group: String(fields.group ?? ''),
    module: String(fields.module ?? ''),
    scope: String(fields.scope ?? ''),
    status: String(fields.status ?? 'active'),
    bytes: Number(fields.bytes ?? 0),
    path: String(fields.path ?? ''),
    description: String(fields.description ?? ''),
    summary: String(fields.summary ?? ''),
    ...(fields.host_name ? { host_name: String(fields.host_name) } : {}),
    ...(fields.current ? { current: true } : {}),
  }
}

/**
 * Pick the agent a session would run as.
 * @param {Record<string, any>} plan - normalized resolve plan.
 * @param {string} [name] - requested persona name.
 * @returns {Record<string, any> | null} the chosen agent.
 */
export function selectAgent(plan, name) {
  const agents = Object.values(record(plan?.agents))
  if (agents.length === 0) return null
  const wanted = String(name ?? '').trim()
  if (wanted.length === 0) {
    return agents.find((entry) => entry.mode !== 'subagent') ?? agents[0]
  }
  return agents.find((entry) => entry.name === wanted)
    ?? agents.find((entry) => String(entry.name).toLowerCase() === wanted.toLowerCase())
    ?? null
}

/**
 * Split an MCP mount key into group, module alias and server name.
 * @param {Record<string, any>} plan - normalized resolve plan.
 * @param {string} key - mount key such as `capability:game_battle_nav`.
 * @returns {{group: string, module: string, server: string}} owner parts.
 */
function mcpOwner(plan, key) {
  const raw = String(key ?? '').replace(/^capability:/u, '')
  const groups = [plan?.core, ...list(plan?.groups)].filter(Boolean)
  for (const group of groups) {
    const prefix = `${String(group.name)}_`
    if (!raw.startsWith(prefix)) continue
    const rest = raw.slice(prefix.length)
    for (const module of list(group.modules)) {
      const alias = String(module?.alias ?? '')
      if (alias.length > 0 && rest.startsWith(`${alias}_`)) {
        return { group: String(group.name), module: alias, server: rest.slice(alias.length + 1) }
      }
    }
    return { group: String(group.name), module: '', server: rest }
  }
  return { group: '', module: '', server: raw }
}

/**
 * Read one content file body, tolerating missing files.
 * @param {(file: string) => Promise<string>} read - file reader.
 * @param {string} file - absolute path.
 * @returns {Promise<string>} stripped body, or an empty string.
 */
async function bodyOf(read, file) {
  if (typeof file !== 'string' || file.length === 0) return ''
  try {
    return stripFrontmatter(await read(file))
  } catch {
    return ''
  }
}

/**
 * Compute the session inventory.
 * @param {{plan: Record<string, any>, cwd?: string, agent?: string, maxRulesBytes?: number, textBytes?: number, home?: string, read?: (file: string) => Promise<string>}} input - plan, working directory and options.
 * @returns {Promise<Record<string, any>>} inventory payload.
 */
export async function buildInventory(input) {
  const plan = record(input?.plan)
  const read = input?.read ?? ((file) => readFile(file, 'utf8'))
  const cwd = normalizePath(input?.cwd)
  const selected = selectAgent(plan, input?.agent)
  const rules = await planRules(plan, { cwd, maxBytes: input?.maxRulesBytes, read })
  const instructions = await hostInstructions({
    project: String(plan.project ?? '.'),
    cwd,
    home: input?.home,
    read,
  })

  const persona = selected === null ? [] : [item({
    kind: 'persona',
    id: selected.id ?? selected.name,
    name: selected.name,
    group: selected.group,
    module: selected.module,
    status: 'active',
    bytes: byteLength(selected.system),
    path: selected.system_path ?? selected.source ?? '',
    description: selected.description,
    summary: summarize(selected.system, selected.description),
    current: true,
  })]

  const skills = []
  for (const skill of list(plan.skills)) {
    const file = `${String(skill.path)}/SKILL.md`
    const body = await bodyOf(read, file)
    skills.push(item({
      kind: 'skill',
      id: skill.id ?? skill.name,
      name: skill.name,
      group: skill.group,
      module: skill.module,
      bytes: byteLength(body),
      path: file,
      description: skill.description,
      summary: skill.description || summarize(body),
      host_name: record(plan.names).skills?.[skill.id] ?? '',
    }))
  }

  const commands = []
  for (const command of Object.values(record(plan.commands))) {
    const body = command.template_path
      ? await bodyOf(read, command.template_path)
      : String(command.template ?? '')
    commands.push(item({
      kind: 'command',
      id: command.id ?? command.name,
      name: command.name,
      group: command.group,
      module: command.module,
      bytes: byteLength(body),
      path: command.template_path ?? command.source ?? '',
      description: command.description,
      summary: command.description || summarize(body),
      host_name: record(plan.names).commands?.[command.id] ?? '',
    }))
  }

  const mcp = []
  for (const [key, entry] of Object.entries(record(plan.mcp))) {
    const data = record(entry)
    const transport = String(data.type ?? '')
    const detail = Array.isArray(data.command)
      ? data.command.map((part) => String(part)).join(' ')
      : String(data.url ?? '')
    const owner = mcpOwner(plan, key)
    mcp.push(item({
      kind: 'mcp',
      id: key,
      name: owner.server || key,
      group: owner.group,
      module: owner.module,
      description: transport,
      summary: `${transport}: ${detail}`.replace(/^: /u, ''),
      host_name: key,
    }))
  }

  const ruleItem = (entry) => item({
    kind: 'rule',
    id: entry.rule.id ?? entry.rule.name,
    name: entry.rule.name,
    group: entry.rule.group,
    module: entry.rule.module,
    scope: entry.rule.scope ?? 'global',
    status: entry.status,
    bytes: entry.bytes || byteLength(entry.body),
    path: entry.rule.path,
    description: entry.rule.description,
    summary: entry.rule.description || summarize(entry.body, entry.rule.name),
  })

  const ruleSection = {
    kind: 'rules',
    title: SECTION_TITLES.rules,
    collapsed: false,
    items: [...rules.injected, ...rules.indexed, ...rules.omitted].map(ruleItem),
  }
  const skippedSection = {
    kind: 'rules-skipped',
    title: SECTION_TITLES['rules-skipped'],
    collapsed: true,
    items: rules.skipped.map((rule) => ruleItem({ rule, status: 'skipped', bytes: 0, body: '' })),
  }

  const roster = Object.values(record(plan.agents)).map((entry) => item({
    kind: 'agent',
    id: entry.id ?? entry.name,
    name: entry.name,
    group: entry.group,
    module: entry.module,
    bytes: byteLength(entry.system),
    path: entry.system_path ?? entry.source ?? '',
    description: entry.description,
    summary: entry.description || String(entry.mode ?? ''),
    current: selected !== null && entry === selected,
  }))

  const sections = [
    { kind: 'agents-md', title: SECTION_TITLES['agents-md'], collapsed: false, items: instructions },
    { kind: 'persona', title: SECTION_TITLES.persona, collapsed: false, items: persona },
    { kind: 'skills', title: SECTION_TITLES.skills, collapsed: false, items: skills },
    { kind: 'commands', title: SECTION_TITLES.commands, collapsed: false, items: commands },
    { kind: 'mcp', title: SECTION_TITLES.mcp, collapsed: false, items: mcp },
    ruleSection,
  ]
  if (skippedSection.items.length > 0) sections.push(skippedSection)
  sections.push({ kind: 'agents', title: SECTION_TITLES.agents, collapsed: true, items: roster })

  return {
    schema_version: INVENTORY_SCHEMA_VERSION,
    project: String(plan.project ?? ''),
    cwd,
    mode: String(plan.mode ?? ''),
    agent: selected === null ? {} : {
      name: selected.name,
      id: selected.id,
      group: selected.group,
      module: selected.module ?? '',
      description: selected.description,
      model: selected.model ?? null,
      system_path: selected.system_path ?? '',
      label: selected.label ?? '',
    },
    model: {
      default: plan.model_default ?? null,
      agent: selected?.model ?? null,
      catalog: list(plan.model_layers).map((layer) => String(layer?.id ?? '')),
    },
    sections,
    budget: { limit: rules.limit, used: rules.text === null ? 0 : rules.used, omitted: rules.omitted.length },
    warnings: list(plan.warnings).map((warning) => String(warning)),
    fingerprint: String(plan.fingerprint ?? ''),
  }
}

/**
 * Resolve one inventory entry to its full text for the hover preview.
 * @param {{plan: Record<string, any>, cwd?: string, kind?: string, id?: string, home?: string, read?: (file: string) => Promise<string>}} input - plan, directory and entry identity.
 * @returns {Promise<{text: string, path: string} | null>} full text, or null when unknown.
 */
export async function inventoryText(input) {
  const plan = record(input?.plan)
  const read = input?.read ?? ((file) => readFile(file, 'utf8'))
  const kind = String(input?.kind ?? '')
  const id = String(input?.id ?? '')

  if (kind === 'agents-md') {
    // Only the chain the host would load is addressable, never an arbitrary path.
    const entries = await hostInstructions({
      project: String(plan.project ?? '.'),
      cwd: input?.cwd,
      home: input?.home,
      read,
      withText: true,
    })
    const match = entries.find((entry) => String(entry.id) === id)
    return match ? { text: String(match.text ?? ''), path: String(match.path ?? '') } : null
  }

  if (kind === 'rule') {
    const rules = await planRules(plan, { cwd: input?.cwd, read })
    const entries = [...rules.injected, ...rules.indexed, ...rules.omitted]
    const match = entries.find((entry) => String(entry.rule.id ?? entry.rule.name) === id)
      ?? rules.skipped.find((rule) => String(rule.id ?? rule.name) === id)
    if (!match) return null
    const rule = match.rule ?? match
    return { text: await bodyOf(read, rule.path), path: String(rule.path) }
  }
  if (kind === 'skill') {
    const skill = list(plan.skills).find((entry) => String(entry.id ?? entry.name) === id)
    if (!skill) return null
    const file = `${String(skill.path)}/SKILL.md`
    return { text: await bodyOf(read, file), path: file }
  }
  if (kind === 'command') {
    const command = Object.values(record(plan.commands))
      .find((entry) => String(entry.id ?? entry.name) === id)
    if (!command) return null
    if (command.template_path) {
      return { text: await bodyOf(read, command.template_path), path: String(command.template_path) }
    }
    return { text: String(command.template ?? ''), path: String(command.source ?? '') }
  }
  if (kind === 'agent' || kind === 'persona') {
    const agent = Object.values(record(plan.agents))
      .find((entry) => String(entry.id ?? entry.name) === id)
    if (!agent) return null
    return { text: String(agent.system ?? ''), path: String(agent.system_path ?? agent.source ?? '') }
  }
  if (kind === 'mcp') {
    const entry = record(plan.mcp)[id]
    if (!entry) return null
    return { text: JSON.stringify(entry, null, 2), path: '' }
  }
  return null
}
