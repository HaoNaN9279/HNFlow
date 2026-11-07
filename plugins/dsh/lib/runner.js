/**
 * The subagent seam.
 *
 * One node execution = one `spawn` activation with `delivery: 'caller'`, so the
 * orchestrator waits for the result without writing a completion notice into
 * the host conversation. The child gets a preset, an optional model route and
 * an envelope schema; everything else is the host's business.
 */

/**
 * Create a runner over the host's subagent service.
 * @param {{subagents: Record<string, any> | undefined}} options - host seam.
 * @returns {{available: () => boolean, spawn: (input: Record<string, any>) => Promise<Record<string, any>>}} runner.
 */
export function createSubagentRunner(options) {
  const subagents = options?.subagents
  return {
    /**
     * Whether delegation is mounted.
     * @returns {boolean} true when the seam exists.
     */
    available() {
      return typeof subagents?.startActivation === 'function'
    },

    /**
     * Start one node activation.
     * @param {{
     *   parent: unknown,
     *   cwd: string,
     *   preset: string,
     *   agentOptions?: Record<string, any>,
     *   label: string,
     *   prompt: string,
     *   outputSchema: Record<string, any>,
     *   signal?: AbortSignal,
     * }} input - activation input.
     * @returns {Promise<{childId: string, result: Promise<{childId: string, stopReason: string, output: unknown[], structured: unknown}>, dispose: () => Promise<void>}>} activation handle.
     */
    async spawn(input) {
      if (!this.available()) {
        throw Object.assign(new Error('the host has no subagent service; a node cannot run'), { code: 'subagent-unavailable' })
      }
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: input.label,
        delivery: 'caller',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        request: {
          parent: input.parent,
          cwd: input.cwd,
          agentPreset: input.preset,
          outputSchema: input.outputSchema,
          // A node never delegates further: the run's budget stays the run's.
          maxDepth: 0,
          ...(input.agentOptions === undefined ? {} : { agentOptions: input.agentOptions }),
          prompt: [{ type: 'text', text: input.prompt }],
        },
      })
      return {
        childId: String(activation.childId ?? ''),
        result: Promise.resolve(activation.result).then((result) => ({
          childId: String(activation.childId ?? ''),
          stopReason: String(result?.stopReason ?? 'error'),
          output: Array.isArray(result?.output) ? result.output : [],
          structured: result?.structured,
        })),
        dispose: async () => {
          await activation.dispose?.()
        },
      }
    },
  }
}

/**
 * Await a promise or a timeout, whichever settles first.
 *
 * The timeout path never cancels silently: the caller receives `timedOut: true`
 * and is expected to dispose the activation.
 * @param {Promise<any>} promise - work to await.
 * @param {number} timeoutMs - budget in milliseconds.
 * @returns {Promise<{timedOut: false, value: any} | {timedOut: true, value: undefined}>} outcome.
 */
export async function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { timedOut: false, value: await promise }
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, value: undefined }), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([promise.then((value) => ({ timedOut: false, value })), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
