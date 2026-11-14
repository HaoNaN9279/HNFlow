/**
 * Inbox staging.
 *
 * A pending is already the unit of "the owner must act"; the stage says what
 * kind of act it is, and the priority decides which one the page shows first.
 * Derived on read: no extra durable field, so old runs stay valid.
 */

/** Stage table: lower priority is handled first. */
export const STAGES = Object.freeze({
  rework: { priority: 0, label: '返工交付' },
  arbitrate: { priority: 1, label: '仲裁' },
  decide: { priority: 2, label: '门禁裁决' },
  deliver: { priority: 3, label: '人工交付' },
})

/**
 * Stage of one open pending.
 * @param {Record<string, any>} pending - gate/request pending.
 * @returns {{stage: string, priority: number, label: string}} stage facts.
 */
export function stageOf(pending) {
  let stage = 'deliver'
  if (pending?.kind === 'gate') stage = pending.origin === 'inconclusive' ? 'arbitrate' : 'decide'
  else if (pending?.kind === 'request' && Number(pending.attempts ?? 0) > 0) stage = 'rework'
  else if (pending?.kind !== 'request') stage = 'decide'
  return { stage, ...STAGES[stage] }
}

/**
 * One-sentence description of what the owner has to do.
 * @param {Record<string, any>} pending - open pending.
 * @param {{run?: Record<string, any>, node?: Record<string, any>}} [context] - optional context.
 * @returns {string} sentence.
 */
export function pendingSummary(pending, context = {}) {
  const flowName = context.run?.flowName ?? context.run?.flowId ?? pending.flowName ?? '流程'
  const node = pending.nodeTitle ?? pending.nodeId ?? '节点'
  switch (stageOf(pending).stage) {
    case 'decide':
      return `在「${flowName}」的门禁 ${node} 上裁决：批准、拒绝或修改后批准`
    case 'arbitrate':
      return `「${flowName}」的 ${node} 验收无法自动判定，需要你仲裁`
    case 'rework':
      return `「${flowName}」的 ${node} 交付被退回，请按意见重新交付（第 ${Number(pending.attempts ?? 0) + 1} 次）`
    default:
      return `为「${flowName}」的 ${node} 提供人工交付物`
  }
}

/**
 * Sort open pending items for the inbox: stage first, then age.
 * @param {Record<string, any>[]} items - inbox items.
 * @returns {Record<string, any>[]} sorted copy.
 */
export function sortPending(items) {
  return [...items].sort((left, right) => {
    const priority = Number(left.priority ?? 9) - Number(right.priority ?? 9)
    if (priority !== 0) return priority
    return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
  })
}
