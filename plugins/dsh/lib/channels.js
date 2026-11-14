/**
 * Delivery channels for human work.
 *
 * The inbox is the authority: a pending is decided once, by the service, from
 * the stored record. A channel only carries a copy of the question to wherever
 * the owner happens to look. Therefore `send` may fail — the inbox still holds
 * the work — and a channel can never mutate run state.
 */

/**
 * Create a channel registry with the built-in inbox.
 * @param {{logger?: Record<string, any>}} [options] - wiring.
 * @returns {{
 *   register: (channel: Record<string, any>) => Record<string, any>,
 *   get: (id: string) => Record<string, any> | undefined,
 *   list: () => Record<string, any>[],
 *   send: (id: string, payload: Record<string, any>) => Promise<{ok: boolean, code?: string, error?: string}>,
 * }} registry.
 */
export function createChannels(options = {}) {
  const logger = options.logger ?? {}
  /** @type {Map<string, Record<string, any>>} */
  const channels = new Map()

  /**
   * Register one channel.
   * @param {Record<string, any>} channel - `{id, title, send, enabled?}`.
   * @returns {Record<string, any>} the registered channel.
   */
  function register(channel) {
    const id = String(channel?.id ?? '')
    if (!/^[a-z][a-z0-9-]{1,30}$/u.test(id)) throw new Error(`channel id ${JSON.stringify(id)} is invalid`)
    if (channels.has(id)) throw new Error(`channel ${id} is already registered`)
    if (typeof channel.send !== 'function') throw new Error(`channel ${id} needs a send(payload) function`)
    const record = Object.freeze({
      id,
      title: typeof channel.title === 'string' && channel.title.length > 0 ? channel.title : id,
      enabled: channel.enabled !== false,
      send: channel.send,
    })
    channels.set(id, record)
    return record
  }

  // The inbox is always present and never fails: it is a marker, not a
  // transport. Anything that shows the inbox (page, notice, command) reads the
  // same service state.
  register({ id: 'inbox', title: '收件箱', send: async () => {} })

  return {
    register,

    /**
     * Read one channel.
     * @param {string} id - channel id.
     * @returns {Record<string, any> | undefined} channel.
     */
    get(id) {
      return channels.get(String(id))
    },

    /**
     * Every channel.
     * @returns {Record<string, any>[]} channels.
     */
    list() {
      return [...channels.values()].map(({ id, title, enabled }) => ({ id, title, enabled }))
    },

    /**
     * Send through one channel, never throwing.
     * @param {string} id - channel id.
     * @param {Record<string, any>} payload - delivery payload.
     * @returns {Promise<{ok: boolean, code?: string, error?: string}>} outcome.
     */
    async send(id, payload) {
      const channel = channels.get(String(id))
      if (channel === undefined) return { ok: false, code: 'channel-unknown' }
      if (channel.enabled === false) return { ok: false, code: 'channel-disabled' }
      try {
        await channel.send(payload)
        return { ok: true }
      } catch (error) {
        logger.warn?.('hnflow: channel %s failed: %o', id, error)
        return { ok: false, code: 'channel-failed', error: String(error?.message ?? error) }
      }
    },
  }
}
