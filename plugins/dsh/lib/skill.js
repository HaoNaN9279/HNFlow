/**
 * Bundled skill loading.
 *
 * The skill body ships with the plugin so it cannot drift from the tool and
 * command contracts. Frontmatter is stripped: DSH receives name, description,
 * and content as separate fields.
 */

/**
 * Split a `SKILL.md` into frontmatter fields and body.
 * @param {string} text - raw file content.
 * @returns {{name: string, description: string, content: string}} parsed skill.
 */
export function readSkillFile(text) {
  const source = String(text ?? '')
  if (!source.startsWith('---')) return { name: '', description: '', content: source.trim() }
  const end = source.indexOf('\n---', 3)
  if (end < 0) return { name: '', description: '', content: source.trim() }
  const front = source.slice(3, end)
  const body = source.slice(end + 4).trim()
  /** @type {Record<string, string>} */
  const fields = {}
  for (const line of front.split('\n')) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key.length > 0) fields[key] = value
  }
  return { name: fields.name ?? '', description: fields.description ?? '', content: body }
}
