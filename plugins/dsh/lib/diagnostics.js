/**
 * Load-time diagnostics.
 *
 * The desktop host has no log file a user can hand back, so each row drops one
 * small JSON breadcrumb under `$DSH_HOME/hnflow/`. It answers the questions a
 * screenshot cannot: did the core row run, did its routes register, did the
 * preset row find the service? Writing is best-effort and must never fail a row.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { dshHome } from './paths.js'

/**
 * Write one breadcrumb.
 * @param {string} name - file stem (`core`, `preset`, …).
 * @param {Record<string, any>} info - payload.
 * @returns {Promise<void>} resolves once written (never rejects).
 */
export async function writeBreadcrumb(name, info) {
  try {
    const directory = path.join(dshHome(), 'hnflow')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, `${name}-status.json`), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...info }, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics are not worth a failed row.
  }
}

/**
 * Wait a tick so a breadcrumb reaches disk even in a short-lived test host.
 * @returns {Promise<void>} resolves on the next macrotask.
 */
export function afterLoad() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 0)
    if (typeof timer.unref === 'function') timer.unref()
  })
}
