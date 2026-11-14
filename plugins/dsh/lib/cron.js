/**
 * Minimal cron matcher for workspace triggers.
 *
 * Five fields: minute hour day-of-month month day-of-week. Supported syntax:
 * `*`, `a`, `a-b`, `* /n`, `a-b/n`, and comma lists of those. This is
 * deliberately smaller than a full cron implementation: triggers only decide
 * whether "this minute matches", and a wrong parse is a configuration error the
 * page shows rather than something to guess around.
 */

/** Field definitions, in cron order. */
const FIELDS = Object.freeze([
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
])

/**
 * Expand one cron field into the set of matching numbers.
 * @param {string} text - field text.
 * @param {{name: string, min: number, max: number}} spec - field bounds.
 * @returns {{ok: true, values: Set<number>} | {ok: false, error: string}} expansion.
 */
function parseField(text, spec) {
  const values = new Set()
  for (const part of text.split(',')) {
    const piece = part.trim()
    if (piece.length === 0) return { ok: false, error: `${spec.name} has an empty list entry` }
    const [rangeText, stepText] = piece.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step <= 0) return { ok: false, error: `${spec.name} has an invalid step ${JSON.stringify(piece)}` }
    let start
    let end
    if (rangeText === '*') {
      start = spec.min
      end = spec.max
    } else if (rangeText.includes('-')) {
      const [left, right] = rangeText.split('-')
      start = Number(left)
      end = Number(right)
      if (!Number.isInteger(start) || !Number.isInteger(end)) return { ok: false, error: `${spec.name} has an invalid range ${JSON.stringify(piece)}` }
    } else {
      start = Number(rangeText)
      end = stepText === undefined ? start : spec.max
      if (!Number.isInteger(start)) return { ok: false, error: `${spec.name} has an invalid value ${JSON.stringify(piece)}` }
    }
    if (start < spec.min || end > spec.max || start > end) {
      return { ok: false, error: `${spec.name} value ${JSON.stringify(piece)} is outside ${spec.min}-${spec.max}` }
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return { ok: true, values }
}

/**
 * Compile a five-field cron expression.
 * @param {string} expression - cron text.
 * @returns {{ok: true, fields: Set<number>[]} | {ok: false, error: string}} compiled expression.
 */
export function parseCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/u)
  if (parts.length !== FIELDS.length) return { ok: false, error: 'cron must have five fields (minute hour day month weekday)' }
  /** @type {Set<number>[]} */
  const fields = []
  for (let index = 0; index < FIELDS.length; index += 1) {
    const parsed = parseField(parts[index], FIELDS[index])
    if (!parsed.ok) return parsed
    fields.push(parsed.values)
  }
  return { ok: true, fields }
}

/**
 * Whether a cron expression matches the given instant (minute precision).
 * @param {string} expression - cron text.
 * @param {Date} date - instant.
 * @returns {boolean} true when the minute matches.
 */
export function cronMatches(expression, date) {
  const parsed = parseCron(expression)
  if (!parsed.ok) return false
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed.fields
  return (
    minute.has(date.getMinutes()) &&
    hour.has(date.getHours()) &&
    dayOfMonth.has(date.getDate()) &&
    month.has(date.getMonth() + 1) &&
    dayOfWeek.has(date.getDay())
  )
}

/**
 * Stable minute bucket, used as the idempotency key of a cron firing.
 * @param {Date} date - instant.
 * @returns {string} `YYYY-MM-DDTHH:mm` in local time.
 */
export function minuteBucket(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
