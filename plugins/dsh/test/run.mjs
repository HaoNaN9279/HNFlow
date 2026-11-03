/**
 * In-process test runner.
 *
 * `node --test test/` spawns one child process per file, which the DSH Windows
 * sandbox denies (EPERM on piped stdio). Importing the files here runs the same
 * tests on a single event loop, so `npm test` works in both environments.
 */

import { readdir } from 'node:fs/promises'

const directory = new URL('./', import.meta.url)
const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.test.js')).sort()
for (const entry of entries) {
  await import(new URL(entry, directory))
}
