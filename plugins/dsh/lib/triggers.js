/**
 * Workspace triggers: what may start a run without a person typing.
 *
 * A trigger is a line in `<workspace>/.hnflow/triggers.json`. It carries a
 * flow name and a condition; it can only *start a new run*, never advance,
 * resume or cancel one. That boundary is what keeps "the flow was pinned to a
 * revision" true: a trigger decides when, not what.
 *
 * Three sources ship: `cron`, `file` and `run-completed`. Each firing has a
 * stable key so the pass cannot start the same run twice.
 */

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { readJsonOrNull } from './assets.js'
import { cronMatches, minuteBucket, parseCron } from './cron.js'
import { stateDir } from './paths.js'

/** Trigger file name inside the workspace state directory. */
export const TRIGGERS_FILE = 'triggers.json'

/** Sources this version understands. */
export const TRIGGER_SOURCES = Object.freeze(['cron', 'file', 'run-completed'])

/** Directories never walked by the file source. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hnflow', 'dist', 'build', '.next', 'coverage'])

/** Walk bounds: a trigger must never make the pass expensive. */
const MAX_FILES = 3000
const MAX_DEPTH = 6

/**
 * Path of the trigger file for a workspace.
 * @param {string} workspace - absolute workspace root.
 * @param {Record<string, any>} config - plugin config.
 * @returns {string} absolute path.
 */
export function triggersPath(workspace, config) {
  return path.join(stateDir(workspace, config), TRIGGERS_FILE)
}

/**
 * Compile a glob into a regular expression (`**`, `*`, `?`).
 * @param {string} pattern - glob.
 * @returns {RegExp} matcher over `/`-separated relative paths.
 */
function globToRegExp(pattern) {
  const text = String(pattern).replace(/\\/gu, '/')
  let out = '^'
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '*') {
      if (text[index + 1] === '*') {
        const slash = text[index + 2] === '/' ? 3 : 2
        out += text[index + 2] === '/' ? '(?:.*/)?' : '.*'
        index += slash - 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    }
  }
  return new RegExp(`${out}$`, 'u')
}

/**
 * Validate one trigger entry.
 * @param {any} entry - raw entry.
 * @param {number} index - position in the file (for messages).
 * @returns {{ok: true, trigger: Record<string, any>} | {ok: false, id: string, error: string}} result.
 */
export function normalizeTrigger(entry, index) {
  const id = typeof entry?.id === 'string' ? entry.id.trim() : `#${index}`
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, id, error: 'trigger must be an object' }
  if (!/^[a-z][a-z0-9-]{0,40}$/u.test(id)) return { ok: false, id, error: 'trigger id must be lower-case words joined by dashes' }
  const source = String(entry.source ?? '')
  if (!TRIGGER_SOURCES.includes(source)) return { ok: false, id, error: `source must be one of ${TRIGGER_SOURCES.join(', ')}` }
  if (typeof entry.flow !== 'string' || entry.flow.trim().length === 0) return { ok: false, id, error: 'flow must be a non-empty flow name' }
  const trigger = {
    id,
    source,
    flow: entry.flow.trim(),
    enabled: entry.enabled !== false,
    input: entry.input !== null && typeof entry.input === 'object' && !Array.isArray(entry.input) ? entry.input : {},
  }
  if (source === 'cron') {
    if (typeof entry.cron !== 'string' || entry.cron.trim().length === 0) return { ok: false, id, error: 'cron source needs a cron expression' }
    const parsed = parseCron(entry.cron)
    if (!parsed.ok) return { ok: false, id, error: parsed.error }
    trigger.cron = entry.cron.trim()
  }
  if (source === 'file') {
    if (!Array.isArray(entry.watch) || entry.watch.length === 0 || entry.watch.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
      return { ok: false, id, error: 'file source needs a non-empty watch array of globs' }
    }
    trigger.watch = entry.watch.map((item) => item.trim())
    trigger.debounceMs = Number.isFinite(entry.debounceMs) && entry.debounceMs >= 0 ? entry.debounceMs : 60_000
  }
  if (source === 'run-completed') {
    if (typeof entry.after !== 'string' || entry.after.trim().length === 0) return { ok: false, id, error: 'run-completed source needs the flow name in "after"' }
    trigger.after = entry.after.trim()
  }
  return { ok: true, trigger }
}

/**
 * Parse the whole file, collecting per-entry errors instead of failing.
 * @param {any} value - parsed JSON.
 * @returns {{triggers: Record<string, any>[], errors: {id: string, error: string}[]}} parsed file.
 */
export function parseTriggers(value) {
  /** @type {Record<string, any>[]} */
  const triggers = []
  /** @type {{id: string, error: string}[]} */
  const errors = []
  const list = Array.isArray(value?.triggers) ? value.triggers : []
  list.forEach((entry, index) => {
    const normalized = normalizeTrigger(entry, index)
    if (normalized.ok) {
      if (triggers.some((item) => item.id === normalized.trigger.id)) {
        errors.push({ id: normalized.trigger.id, error: 'duplicate trigger id' })
        return
      }
      triggers.push(normalized.trigger)
    } else {
      errors.push({ id: normalized.id, error: normalized.error })
    }
  })
  return { triggers, errors }
}

/**
 * Read and parse a workspace's trigger file.
 * @param {string} workspace - absolute workspace root.
 * @param {Record<string, any>} config - plugin config.
 * @returns {Promise<{triggers: Record<string, any>[], errors: {id: string, error: string}[], missing: boolean}>} file content.
 */
export async function readTriggers(workspace, config) {
  const parsed = await readJsonOrNull(triggersPath(workspace, config))
  if (parsed === null) return { triggers: [], errors: [], missing: true }
  return { ...parseTriggers(parsed), missing: false }
}

/**
 * Compute a change signature over the files matched by a trigger's globs.
 * @param {string} workspace - absolute workspace root.
 * @param {string[]} patterns - globs, relative to the workspace.
 * @returns {Promise<{signature: string, count: number, maxMtime: number}>} signature.
 */
export async function fileSignature(workspace, patterns) {
  const matchers = patterns.map(globToRegExp)
  /** @type {{path: string, mtime: number, size: number}[]} */
  const matches = []
  /**
   * Walk one directory.
   * @param {string} dir - absolute directory.
   * @param {string} prefix - relative prefix.
   * @param {number} depth - current depth.
   * @returns {Promise<void>} resolves when walked.
   */
  async function walk(dir, prefix, depth) {
    if (depth > MAX_DEPTH || matches.length >= MAX_FILES) return
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (matches.length >= MAX_FILES) return
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(dir, entry.name), relative, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!matchers.some((matcher) => matcher.test(relative))) continue
      try {
        const info = await stat(path.join(dir, entry.name))
        matches.push({ path: relative, mtime: info.mtimeMs, size: info.size })
      } catch {
        // A file that vanished between readdir and stat is simply not watched.
      }
    }
  }
  await walk(workspace, '', 0)
  const maxMtime = matches.reduce((value, file) => Math.max(value, Math.round(file.mtime)), 0)
  const totalSize = matches.reduce((value, file) => value + file.size, 0)
  return { signature: `${matches.length}:${maxMtime}:${totalSize}`, count: matches.length, maxMtime }
}

/**
 * Triggers that should start when the given flow completes.
 * @param {Record<string, any>[]} triggers - parsed triggers.
 * @param {string} flowId - completed flow id.
 * @returns {Record<string, any>[]} matching triggers.
 */
export function runCompletedTriggers(triggers, flowId) {
  return triggers.filter((trigger) => trigger.source === 'run-completed' && trigger.enabled && (trigger.after === '*' || trigger.after === flowId))
}

/**
 * Evaluate the polling sources of one workspace.
 * @param {{
 *   workspace: string,
 *   triggers: Record<string, any>[],
 *   state: Record<string, any>,
 *   now: Date,
 * }} input - evaluation input.
 * @returns {Promise<{fired: Record<string, any>[], state: Record<string, any>, errors: {id: string, error: string}[]}>} firings.
 */
export async function evaluateTriggers(input) {
  const { workspace, triggers, now } = input
  const state = { ...input.state }
  /** @type {Record<string, any>[]} */
  const fired = []
  /** @type {{id: string, error: string}[]} */
  const errors = []
  for (const trigger of triggers) {
    if (!trigger.enabled) continue
    const key = `${workspace}#${trigger.id}`
    const previous = state[key] ?? {}
    if (trigger.source === 'cron') {
      const bucket = minuteBucket(now)
      if (previous.lastKey === bucket) continue
      if (!cronMatches(trigger.cron, now)) continue
      state[key] = { lastKey: bucket, lastFiredAt: now.toISOString() }
      fired.push({ trigger, key: `${trigger.id}:${bucket}` })
      continue
    }
    if (trigger.source === 'file') {
      let signature
      try {
        signature = await fileSignature(workspace, trigger.watch)
      } catch (error) {
        errors.push({ id: trigger.id, error: String(error?.message ?? error) })
        continue
      }
      if (signature.count === 0) continue
      if (previous.lastKey === signature.signature) continue
      const settledFor = now.getTime() - signature.maxMtime
      if (settledFor < trigger.debounceMs) continue
      state[key] = { lastKey: signature.signature, lastFiredAt: now.toISOString() }
      fired.push({ trigger, key: `${trigger.id}:${signature.signature}` })
    }
  }
  return { fired, state, errors }
}
