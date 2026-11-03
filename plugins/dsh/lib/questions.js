/**
 * Turn a pending human task into question cards.
 *
 * The engine owns the task contract (declared output ports, review decision);
 * this module only maps it onto DSH's question vocabulary — selectable options
 * plus optional custom text — and back into a submission payload.
 */

/** Option label used for a review approval. */
export const APPROVE_LABEL = '通过'
/** Option label used for a review rejection. */
export const REJECT_LABEL = '打回'

/**
 * Build the question cards for one task.
 * @param {Record<string, any>} task - task summary from the engine.
 * @returns {{questions: Record<string, any>[], build: (answer: {answers: Record<string, any>[]}) => Record<string, any> | null}} cards and the payload builder.
 */
export function questionsForTask(task) {
  if (task.kind === 'review') return reviewQuestions(task)
  return portQuestions(task)
}

/**
 * One review question: approve or reject, with the rejection reason as text.
 * @param {Record<string, any>} task - task summary.
 * @returns {{questions: Record<string, any>[], build: Function}} cards and builder.
 */
function reviewQuestions(task) {
  const questions = [
    {
      id: `review-${task.taskId}`,
      header: '人工审核',
      question: task.description || `审核节点 ${task.nodeId}`,
      options: [
        { label: APPROVE_LABEL, description: '通过并继续' },
        { label: REJECT_LABEL, description: '打回并填写原因' },
      ],
    },
  ]
  /**
   * Turn the answer into a review resume payload.
   * @param {{answers: Record<string, any>[]}} answer - service answer.
   * @returns {Record<string, any> | null} payload, or null when nothing was chosen.
   */
  const build = (answer) => {
    const entry = answer?.answers?.[0]
    if (entry === undefined) return null
    const custom = typeof entry.custom === 'string' ? entry.custom.trim() : ''
    const selected = Array.isArray(entry.selected) ? entry.selected : []
    const choice = custom.length > 0 ? custom : (selected[0] ?? '')
    if (choice === APPROVE_LABEL) return { decision: true, feedback: '' }
    if (choice === REJECT_LABEL || selected.includes(REJECT_LABEL)) return { decision: false, feedback: custom }
    return null
  }
  return { questions, build }
}

/**
 * One question per declared output port.
 * @param {Record<string, any>} task - task summary.
 * @returns {{questions: Record<string, any>[], build: Function}} cards and builder.
 */
function portQuestions(task) {
  const ports = Array.isArray(task.outputSpec?.ports) ? task.outputSpec.ports : []
  const questions = ports.map((port) => {
    /** @type {Record<string, any>} */
    const question = {
      id: `${task.taskId}:${port.name}`,
      header: port.name,
      question: port.description || `填写字段 ${port.name}`,
    }
    if (port.type === 'bool') question.options = [{ label: 'true' }, { label: 'false' }]
    return question
  })
  /**
   * Turn the answers into a task payload.
   * @param {{answers: Record<string, any>[]}} answer - service answer.
   * @returns {Record<string, any> | null} payload, or null when a required port is missing.
   */
  const build = (answer) => {
    const byId = new Map((answer?.answers ?? []).map((entry) => [entry.id, entry]))
    /** @type {Record<string, any>} */
    const payload = {}
    for (const port of ports) {
      const entry = byId.get(`${task.taskId}:${port.name}`)
      const value = valueOf(entry)
      if (value === undefined) {
        if (port.required === true) return null
        continue
      }
      payload[port.name] = port.type === 'bool' ? value === 'true' || value === true : coerce(port.type, value)
    }
    return Object.keys(payload).length > 0 ? payload : null
  }
  return { questions, build }
}

/**
 * The chosen or typed value of one answer.
 * @param {Record<string, any> | undefined} entry - answer entry.
 * @returns {string | undefined} value, or undefined when skipped.
 */
function valueOf(entry) {
  if (entry === undefined) return undefined
  const custom = typeof entry.custom === 'string' ? entry.custom.trim() : ''
  if (custom.length > 0) return custom
  const selected = Array.isArray(entry.selected) ? entry.selected : []
  return typeof selected[0] === 'string' ? selected[0] : undefined
}

/**
 * Coerce a text answer to the port's declared type.
 * @param {string} type - port type.
 * @param {string} value - raw text.
 * @returns {any} typed value.
 */
function coerce(type, value) {
  if (type === 'number') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  if (type === 'array' || type === 'record' || type === 'data') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}
