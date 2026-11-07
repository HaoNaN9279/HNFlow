/**
 * Prompt assembly for node children.
 *
 * A spawned child starts with an empty conversation, so the brief must be
 * self-contained: the task, the upstream artifacts it may consume, the output
 * contract it must satisfy, and the three envelope states it may declare.
 * Big artifacts are inlined up to a bound and referenced by node id beyond it —
 * the child can read the run record through the tool if it needs the rest.
 */

/** Bytes of one artifact inlined into a brief before it is referenced instead. */
export const MAX_ARTIFACT_CHARS = 8000

/**
 * Render `{{input.x}}` / `{{nodes.<id>.output.y}}` references.
 * @param {string} text - instruction template.
 * @param {{input?: Record<string, any>, nodes?: Record<string, any>, flow?: Record<string, any>}} context - values.
 * @returns {string} rendered text.
 */
export function renderTemplate(text, context) {
  return String(text ?? '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/gu, (_match, path) => {
    const value = readPath(context, String(path))
    if (value === undefined) return ''
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  })
}

/**
 * Read a dotted path.
 * @param {Record<string, any>} root - context.
 * @param {string} path - dotted path.
 * @returns {any} value, or undefined.
 */
export function readPath(root, path) {
  let current = root
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined
    current = current[part]
  }
  return current
}

/**
 * Describe one upstream value for the brief.
 * @param {{from: string, value: any}} artifact - upstream artifact.
 * @returns {string} fenced block.
 */
function describeArtifact(artifact) {
  const text = typeof artifact.value === 'string' ? artifact.value : JSON.stringify(artifact.value ?? null, null, 2)
  const truncated = text.length > MAX_ARTIFACT_CHARS
  return [
    `### 上游产物 \`${artifact.from}\``,
    '```json',
    truncated ? `${text.slice(0, MAX_ARTIFACT_CHARS)}\n…（已截断）` : text,
    '```',
  ].join('\n')
}

/**
 * Build the brief handed to an agent/judge child.
 * @param {{
 *   flow: Record<string, any>,
 *   node: Record<string, any>,
 *   run: Record<string, any>,
 *   upstream: {from: string, value: any}[],
 *   outputSchema: Record<string, any>,
 * }} input - node context.
 * @returns {string} prompt text.
 */
export function buildNodeBrief(input) {
  const { flow, node, run, upstream, outputSchema } = input
  const rendered = renderTemplate(node.instruction ?? '', { input: run.input ?? {}, flow: flow.flow ?? {}, nodes: run.nodes ?? {} })
  const lines = [
    `你是 HNFlow 流程「${flow.flow?.name ?? flow.flow?.id ?? '未命名'}」中的节点 \`${node.id}\`（${node.type}）。`,
    '',
    '## 任务',
    rendered.length > 0 ? rendered : '（节点未写 instruction；按上游产物完成该节点应当完成的工作。）',
    '',
  ]
  if (upstream.length > 0) {
    lines.push('## 可消费的上游产物', '', ...upstream.map((artifact) => describeArtifact(artifact)), '')
  } else {
    lines.push('## 可消费的上游产物', '', '（无：你是起点节点，使用下面的启动输入。）', '')
  }
  lines.push('## 启动输入', '', '```json', JSON.stringify(run.input ?? {}, null, 2), '```', '')
  lines.push(
    '## 输出契约',
    '',
    '调用 `structured_output` 工具提交结果，且只提交三态信封之一：',
    '',
    '```jsonc',
    JSON.stringify(
      {
        status: 'done',
        output: outputSchema,
        evidence: ['可选：你据以得出该结果的证据'],
        notes: '可选说明',
      },
      null,
      2,
    ),
    '```',
    '',
    '- `status: "done"`：你完成了任务，`output` 必须满足上面的输出契约。',
    '- `status: "needs_human"`：这件事需要人来做。给出 `needsHuman.reason`（capability_gap / real_world_judgement / authority / ambiguous_intent / asset_unavailable）、`deliverable`（缺口的形状）、`whyHuman`（为什么模型不可替代）。**不要等待**，声明后结束本轮。',
    '- `status: "failed"`：确实无法完成，给出 `error.code` 与 `error.message`。',
    '',
    '## 约束',
    '',
    '- 不要委派给其他 agent（`maxDepth: 0`，子代理不能再开子代理）。',
    '- 不要向用户提问：你不是交互根，问题会被拒绝；需要人时用 `needs_human` 上抛。',
    '- 不要执行需要审批的操作：子代理的权限在启动时固定，需要审批的操作会被自动拒绝。',
    '- 完成状态由流程判定：自报 `done` 之后，插件仍会按契约校验并决定下游是否放行。',
    '',
    `## 运行环境`,
    '',
    `- run: \`${run.runId}\``,
    `- 节点: \`${node.id}\``,
    `- 工作区: \`${run.workspace}\``,
  )
  return lines.join('\n')
}

/**
 * Build the brief handed to a verify node's judge child.
 * @param {{
 *   flow: Record<string, any>,
 *   node: Record<string, any>,
 *   run: Record<string, any>,
 *   requestNode: Record<string, any>,
 *   delivery: any,
 * }} input - verify context.
 * @returns {string} prompt text.
 */
export function buildJudgeBrief(input) {
  const { flow, node, run, requestNode, delivery } = input
  const criteria = typeof node.judge?.criteria === 'string' ? node.judge.criteria : ''
  return [
    `你是 HNFlow 流程「${flow.flow?.name ?? flow.flow?.id ?? '未命名'}」中的验收判定者（verify \`${node.id}\`）。`,
    '',
    '你只验收交付物本身，不重做任务，也不改写交付物。',
    '',
    '## 验收标准',
    '',
    criteria.length > 0 ? criteria : '交付物必须满足请求中声明的交付契约。',
    '',
    '## 交付请求',
    '',
    `- 节点: \`${requestNode.id}\``,
    `- 为什么必须由人完成: ${requestNode.whyHuman ?? '（未声明）'}`,
    '',
    '```json',
    JSON.stringify(requestNode.deliverable ?? {}, null, 2),
    '```',
    '',
    '## 人的交付物',
    '',
    '```json',
    JSON.stringify(delivery ?? null, null, 2).slice(0, MAX_ARTIFACT_CHARS),
    '```',
    '',
    '## 输出契约',
    '',
    '提交 `{status:"done", output:{verdict:"accept"|"reject"|"needs_more", reasons:[...], conditions:[...]}}`。',
    '`accept` 必须给出理由；`reject` 要指出具体违反的条款；`needs_more` 要说明还缺什么。',
    '',
    '不要向用户提问，不要委派，不要执行需要审批的操作。',
    `运行: run \`${run.runId}\`，工作区 \`${run.workspace}\`。`,
  ].join('\n')
}
