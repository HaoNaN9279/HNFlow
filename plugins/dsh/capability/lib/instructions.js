/**
 * Host workspace instructions.
 *
 * The host injects one baseline per session: the user-global `AGENTS.md` files
 * first, then every candidate from the project root down to the working
 * directory, broad to specific. Files whose trimmed content repeats an earlier
 * candidate are not rendered again; this module reports them as skipped so the
 * panel explains why one copy is missing from the prompt.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const BASE_INSTRUCTION_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md'])
export const LOCAL_INSTRUCTION_FILES = Object.freeze(['AGENTS.local.md', 'CLAUDE.local.md'])
export const PROJECT_ROOT_MARKER = '.git'
export const INSTRUCTION_SECTION_TITLE = 'Workspace instructions (AGENTS.md)'

const SUMMARY_LIMIT = 200

/**
 * Byte length of a string as UTF-8.
 * @param {string} text - text to measure.
 * @returns {number} byte length.
 */
function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/**
 * First meaningful line, used as the row summary.
 * @param {string} text - body text.
 * @param {string} fallback - text to use when the body is empty.
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
 * Convert a native path to the posix identity used on the wire.
 * @param {string} file - path to convert.
 * @returns {string} posix-shaped path.
 */
function posix(file) {
  return file.split(path.sep).join('/')
}

/**
 * Loop-free label for a file under the user home directory.
 * @param {string} file - absolute path.
 * @param {string} home - resolved home directory.
 * @returns {string} `~/...` when inside home, else the posix path.
 */
function homeLabel(file, home) {
  const relative = path.relative(home, file)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? `~/${posix(relative)}`
    : posix(file)
}

/**
 * Nearest ancestor that carries the host project-root marker.
 * @param {string} root - project directory.
 * @returns {string} host root.
 */
function hostRoot(root) {
  let current = root
  for (;;) {
    if (existsSync(path.join(current, PROJECT_ROOT_MARKER))) return current
    const parent = path.dirname(current)
    if (parent === current) return root
    current = parent
  }
}

/**
 * Directories from the host root down to the target directory.
 * @param {string} root - project directory.
 * @param {string} target - working directory.
 * @returns {string[]} ordered directory list.
 */
function directoryChain(root, target) {
  const base = hostRoot(root)
  const relative = path.relative(base, target)
  const inside = relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative))
  const directories = [base]
  if (!inside) return directories
  let current = base
  for (const part of relative.split(path.sep).filter((value) => value.length > 0)) {
    current = path.join(current, part)
    directories.push(current)
  }
  return directories
}

/**
 * Build the host instruction chain for one session.
 * @param {{project?: string, cwd?: string, home?: string, withText?: boolean, textLimit?: number, read?: (file: string) => Promise<string>}} input - project, working directory, home and options.
 * @returns {Promise<Array<Record<string, any>>>} ordered inventory items.
 */
export async function hostInstructions(input) {
  const project = path.resolve(String(input?.project ?? '.'))
  const cwd = String(input?.cwd ?? '').replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
  const home = path.resolve(String(input?.home ?? os.homedir()))
  const read = input?.read ?? ((file) => readFile(file, 'utf8'))
  const withText = input?.withText === true
  const textLimit = Number.isFinite(input?.textLimit) && input.textLimit > 0
    ? Number(input.textLimit)
    : 65536

  const dshHome = input?.dshHome
    ? path.resolve(String(input.dshHome))
    : input?.home
      ? path.join(home, '.dsh')
      : process.env.DSH_HOME
        ? path.resolve(process.env.DSH_HOME)
        : path.join(home, '.dsh')
  const globalDsh = path.join(dshHome, 'AGENTS.md')
  const globalAgents = path.join(home, '.agents', 'AGENTS.md')
  const entries = [
    { file: globalDsh, label: homeLabel(globalDsh, home), scope: 'global' },
    { file: globalAgents, label: homeLabel(globalAgents, home), scope: 'global' },
  ]

  const target = cwd.length > 0 ? path.join(project, ...cwd.split('/')) : project
  for (const directory of directoryChain(project, target)) {
    const relative = path.relative(project, directory).split(path.sep).join('/')
    const scope = relative.length === 0 ? 'global' : 'paths'
    const prefix = relative.length === 0 ? '' : `${relative}/`
    for (const name of [...BASE_INSTRUCTION_FILES, ...LOCAL_INSTRUCTION_FILES]) {
      entries.push({ file: path.join(directory, name), label: `${prefix}${name}`, scope })
    }
  }

  const items = []
  const seen = new Map()
  for (const entry of entries) {
    if (!existsSync(entry.file)) continue
    let body
    try {
      body = await read(entry.file)
    } catch {
      continue
    }
    if (typeof body !== 'string' || body.trim().length === 0) continue
    const key = body.trim()
    const duplicate = seen.get(key)
    let status = 'injected'
    let description = 'Injected with the first session message'
    if (duplicate !== undefined) {
      status = 'skipped'
      description = `Same content as ${duplicate}; the host does not repeat it`
    } else {
      seen.set(key, entry.label)
    }
    let text
    let truncated = false
    if (withText) {
      const encoded = Buffer.from(body, 'utf8')
      if (encoded.length > textLimit) {
        text = encoded.subarray(0, textLimit).toString('utf8')
        truncated = true
      } else {
        text = body
      }
    }
    items.push({
      kind: 'agents-md',
      id: posix(entry.file),
      name: entry.label,
      group: 'host',
      module: '',
      scope: entry.scope,
      status,
      bytes: byteLength(body),
      path: entry.file,
      description,
      summary: summarize(body, entry.label),
      ...(withText ? { text, truncated } : {}),
    })
  }
  return items
}
