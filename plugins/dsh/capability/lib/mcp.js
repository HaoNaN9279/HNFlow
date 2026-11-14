/**
 * Capability-group MCP servers.
 *
 * DSH configures one `@deepseek-ai/dsh-mcp-client` row per server. Capability
 * servers are project data, so this module normalizes them into client configs
 * and mounts one child plugin per server inside the mode's agent scope.
 */

import { createHash } from 'node:crypto'

const SERVER_NAME_MAX = 32
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u

/**
 * Turn a resolve key into a DSH server namespace.
 * @param {string} key - resolve key such as `capability:core_demo`.
 * @returns {string} `[A-Za-z0-9_-]{1,32}` server name.
 */
export function sanitizeServerName(key) {
  const raw = String(key ?? '')
    .replace(/^capability:/u, '')
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/^_+/u, '')
  const base = raw.length > 0 ? `vibe_${raw}` : 'vibe'
  if (NAME_PATTERN.test(base)) return base
  const suffix = createHash('sha256').update(String(key ?? ''), 'utf8').digest('hex').slice(0, 8)
  const trimmed = base.slice(0, SERVER_NAME_MAX - suffix.length - 1).replace(/_+$/u, '')
  return `${trimmed}_${suffix}`
}

/**
 * Normalize one resolve MCP entry.
 * @param {string} key - resolve key.
 * @param {unknown} value - MCP entry from the plan.
 * @returns {{key: string, serverName: string, config: Record<string, unknown>, signature: string} | null} mountable entry.
 */
export function normalizeMcpEntry(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.enabled === false) return null
  const serverName = sanitizeServerName(key)
  const type = typeof value.type === 'string' ? value.type : ''
  let config
  if (type === 'remote' || type === 'streamable-http' || type === 'http') {
    if (typeof value.url !== 'string' || value.url.length === 0) return null
    config = {
      serverName,
      transport: 'streamable-http',
      url: value.url,
      failOnStartupError: false,
    }
    if (value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)) {
      config.headers = { ...value.headers }
    }
  } else {
    const command = Array.isArray(value.command)
      ? value.command.filter((item) => typeof item === 'string' && item.length > 0)
      : typeof value.command === 'string' && value.command.length > 0
        ? [value.command]
        : []
    if (command.length === 0) return null
    config = {
      serverName,
      transport: 'stdio',
      command: command[0],
      args: command.slice(1),
      failOnStartupError: false,
    }
    if (value.env && typeof value.env === 'object' && !Array.isArray(value.env)) {
      config.env = { ...value.env }
    }
    if (typeof value.cwd === 'string' && value.cwd.length > 0) config.cwd = value.cwd
  }
  return { key, serverName, config, signature: JSON.stringify(config) }
}

/**
 * Normalize every MCP entry of a plan.
 * @param {Record<string, unknown>} mcp - plan `mcp` object.
 * @returns {{key: string, serverName: string, config: Record<string, unknown>, signature: string}[]} mountable entries.
 */
export function normalizeMcpEntries(mcp) {
  const source = mcp && typeof mcp === 'object' ? mcp : {}
  const entries = []
  for (const [key, value] of Object.entries(source)) {
    const entry = normalizeMcpEntry(key, value)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

/**
 * Reconcile mounted MCP servers with the current plan.
 *
 * Mount failures are contained: the mode keeps working without that server.
 * @param {{plugin: Function, logger?: {warn: Function}}} ctx - plugin context.
 * @param {Map<string, {signature: string, fiber: unknown}>} store - mounted servers.
 * @param {{key: string, serverName: string, config: Record<string, unknown>, signature: string}[]} entries - desired servers.
 * @param {() => Promise<Record<string, unknown>>} loadModule - dynamic import of the MCP client package.
 * @returns {Promise<void>} resolves after reconciliation.
 */
export async function syncMcpServers(ctx, store, entries, loadModule) {
  const desired = new Map(entries.map((entry) => [entry.key, entry]))
  for (const [key, mounted] of [...store]) {
    const next = desired.get(key)
    if (next !== undefined && next.signature === mounted.signature) continue
    store.delete(key)
    try {
      await mounted.fiber?.dispose?.()
    } catch (error) {
      ctx.logger?.warn?.('capability: failed to dispose MCP server %s: %o', key, error)
    }
  }
  for (const entry of entries) {
    if (store.has(entry.key)) continue
    let module
    try {
      module = await loadModule()
    } catch (error) {
      ctx.logger?.warn?.('capability: MCP client unavailable (%s): %o', entry.serverName, error)
      return
    }
    try {
      const fiber = ctx.plugin(module, entry.config)
      store.set(entry.key, { signature: entry.signature, fiber })
    } catch (error) {
      ctx.logger?.warn?.('capability: cannot mount MCP server %s: %o', entry.serverName, error)
    }
  }
}
