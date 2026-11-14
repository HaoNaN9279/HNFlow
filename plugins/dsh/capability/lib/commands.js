/**
 * Capability-group commands as DSH slash commands.
 *
 * DSH command names are a fixed lowercase grammar, and command handlers run
 * directly against the agent. A Capability command is a prompt template, so the
 * handler renders the template and submits it as a normal user turn.
 *
 * Every command is published under the `capability-<group>-<name>` namespace so
 * Core and domain groups can never collide, and the handler re-reads the
 * current workspace's plan before it renders anything.
 */

import { canonicalName, validCommandName } from './names.js'

export { validCommandName }

/**
 * Extract selectable command definitions from a plan.
 * @param {Record<string, unknown>} plan - normalized resolve plan.
 * @param {{prefix?: string, maxLength?: number}} [options] - namespace options.
 * @param {string[]} [warnings] - collector for dropped or colliding entries.
 * @returns {{name: string, canonical: string, group: string, description: string, template: string, model: string}[]} usable commands.
 */
export function commandEntries(plan, options = {}, warnings = []) {
  const commands = plan?.commands && typeof plan.commands === 'object' ? plan.commands : {}
  const published = plan?.names && typeof plan.names === 'object' ? plan.names : {}
  const assigned = published.commands && typeof published.commands === 'object' ? published.commands : {}
  const entries = []
  const seen = new Set()
  for (const [name, value] of Object.entries(commands)) {
    if (!value || typeof value !== 'object') continue
    const description = typeof value.description === 'string' ? value.description.trim() : ''
    const template = typeof value.template === 'string' ? value.template : ''
    if (description.length === 0 || template.length === 0) continue
    const group = typeof value.group === 'string' && value.group.length > 0 ? value.group : 'core'
    const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : ''
    const mapped = id.length > 0 && typeof assigned[id] === 'string' ? assigned[id] : ''
    const canonical = mapped.length > 0
      ? mapped
      : canonicalName(options.prefix, group, name, options)
    if (canonical.length === 0) {
      warnings.push(`command ${group}/${name} has no usable name`)
      continue
    }
    if (!validCommandName(canonical)) {
      warnings.push(`command ${group}/${name} produces an invalid DSH name: ${canonical}`)
      continue
    }
    if (seen.has(canonical)) {
      warnings.push(`command name collision: ${canonical}`)
      continue
    }
    seen.add(canonical)
    entries.push({
      name,
      canonical,
      group,
      description,
      template,
      model: typeof value.model === 'string' ? value.model : '',
    })
  }
  return entries
}

/**
 * Substitute DSH-supported template placeholders.
 *
 * `$ARGUMENTS` and `$1`..`$9` are supported. `` !`cmd` `` and `@file` are left
 * untouched: this adapter does not run shells or expand file references.
 * @param {string} template - command body from the capability group.
 * @param {string} rawInput - everything the user typed after the command name.
 * @returns {string} rendered prompt text.
 */
export function renderTemplate(template, rawInput) {
  const input = String(rawInput ?? '').trim()
  const args = input.length === 0 ? [] : input.split(/\s+/u)
  return String(template ?? '')
    .replaceAll('$ARGUMENTS', input)
    .replace(/\$([1-9])/gu, (_match, digit) => args[Number(digit) - 1] ?? '')
}
