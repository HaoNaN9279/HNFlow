/**
 * The engine client: one stdio child, line-delimited JSON-RPC 2.0.
 *
 * The engine process owns run truth; this client owns nothing but the pipe. A
 * crashed engine invalidates every in-flight request instead of hanging them,
 * and the next request respawns the process after a fresh handshake.
 */

import { spawn } from 'node:child_process'

/** Must match `deerflow.workflow.rpc.protocol.PROTOCOL_VERSION`. */
export const PROTOCOL_VERSION = 1

/** Default engine module entry point. */
export const DEFAULT_ENGINE_MODULE = 'deerflow.workflow.rpc'

/** An engine failure with a stable code (transport or engine-defined). */
export class EngineError extends Error {
  /**
   * @param {string} code - stable reason (`engine-not-started`, `protocol-mismatch`, ….
   * @param {string} message - human-readable explanation.
   * @param {Record<string, unknown>} [data] - extra context.
   */
  constructor(code, message, data = {}) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.data = data
  }
}

/**
 * A JSON-RPC client for the workflow engine.
 */
export class EngineClient {
  /**
   * @param {{
   *   python: string,
   *   module?: string,
   *   cwd?: string,
   *   env?: Record<string, string>,
   *   requestTimeoutMs?: number,
   *   startupTimeoutMs?: number,
   *   logger?: {warn?: Function, debug?: Function},
   * }} options - process and timeout settings.
   */
  constructor(options) {
    /** @type {string} */
    this.python = options.python
    /** @type {string} */
    this.module = options.module ?? DEFAULT_ENGINE_MODULE
    /** @type {string[] | null} */
    this.command = Array.isArray(options.command) && options.command.length > 0 ? [...options.command] : null
    /** @type {typeof spawn} */
    this.spawnImpl = typeof options.spawn === 'function' ? options.spawn : spawn
    /** @type {string | undefined} */
    this.cwd = options.cwd
    /** @type {Record<string, string>} */
    this.env = options.env ?? {}
    /** @type {number} */
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120000
    /** @type {number} */
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20000
    /** @type {{warn?: Function, debug?: Function}} */
    this.logger = options.logger ?? {}
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
    this.child = null
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map()
    /** @type {Set<(message: Record<string, any>) => void>} */
    this.listeners = new Set()
    this.buffer = ''
    this.stderrTail = []
    this.nextId = 1
    this.ready = false
    /** @type {Record<string, any> | null} */
    this.handshake = null
  }

  /**
   * Subscribe to engine notifications (`run/event`, `run/status`).
   * @param {(message: Record<string, any>) => void} listener - callback.
   * @returns {() => void} unsubscribe function.
   */
  onNotification(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Spawn the engine and complete the version handshake.
   * @returns {Promise<Record<string, any>>} the handshake result.
   */
  async ensureStarted() {
    if (this.ready && this.child !== null) return this.handshake ?? { protocolVersion: PROTOCOL_VERSION }
    this.stderrTail = []
    const command = this.command ?? [this.python, '-m', this.module]
    const child = this.spawnImpl(command[0], command.slice(1), {
      cwd: this.cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderrTail.push(String(chunk))
      if (this.stderrTail.length > 40) this.stderrTail.shift()
    })
    child.on('exit', (code, signal) => this.#onExit(code, signal))
    child.on('error', (error) => this.#failAll(new EngineError('engine-spawn-failed', `cannot start the engine: ${error.message}`)))

    try {
      const init = await this.request('engine/initialize', { protocolVersion: PROTOCOL_VERSION, client: { name: 'dsh-hnflow', version: '0.1.0' } }, this.startupTimeoutMs)
      this.ready = true
      this.handshake = init
      return init
    } catch (error) {
      this.stop()
      throw error
    }
  }

  /**
   * Send one request and await its response.
   * @param {string} method - RPC method name.
   * @param {Record<string, any>} [params] - request parameters.
   * @param {number} [timeoutMs] - override the configured timeout.
   * @returns {Promise<any>} the `result` member.
   */
  async request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const child = this.child
    if (child === null || child.stdin.destroyed) throw new EngineError('engine-not-started', 'the workflow engine is not running')
    const id = this.nextId++
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new EngineError('engine-timeout', `engine did not answer ${method} within ${timeoutMs}ms`, { method, timeoutMs }))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(payload, (error) => {
        if (error === null || error === undefined) return
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        reject(new EngineError('engine-write-failed', error.message))
      })
    })
  }

  /**
   * Send a notification (no id, no response expected).
   * @param {string} method - RPC method name.
   * @param {Record<string, any>} [params] - notification parameters.
   * @returns {void}
   */
  notify(method, params = {}) {
    const child = this.child
    if (child === null || child.stdin.destroyed) return
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /**
   * Stop the engine: graceful shutdown first, kill after a short grace period.
   * @returns {void}
   */
  stop() {
    const child = this.child
    this.child = null
    this.ready = false
    this.handshake = null
    this.#failAll(new EngineError('engine-stopped', 'the workflow engine was stopped'))
    if (child === null) return
    try {
      child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'engine/shutdown', params: {} })}\n`)
    } catch {
      // The pipe is already gone; the kill below is the real cleanup.
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already exited.
      }
    }, 1500)
    timer.unref?.()
    child.once('exit', () => clearTimeout(timer))
  }

  /**
   * Whether the engine process is alive and handshaken.
   * @returns {boolean} true when requests will be served.
   */
  isRunning() {
    return this.ready && this.child !== null
  }

  // 鈹€鈹€ internals 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  /**
   * Consume a stdout chunk, dispatching every complete line.
   * @param {string} chunk - decoded text.
   * @returns {void}
   */
  #onData(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) this.#onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  /**
   * Handle one JSON-RPC frame.
   * @param {string} line - raw line.
   * @returns {void}
   */
  #onLine(line) {
    /** @type {Record<string, any>} */
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      this.logger.warn?.('hnflow: engine emitted a non-JSON line: %o', error)
      return
    }
    if (message.id === undefined || message.id === null) {
      if (typeof message.method === 'string') {
        for (const listener of this.listeners) {
          try {
            listener(message)
          } catch (error) {
            this.logger.warn?.('hnflow: notification listener failed: %o', error)
          }
        }
      }
      return
    }
    const entry = this.pending.get(Number(message.id))
    if (entry === undefined) return
    this.pending.delete(Number(message.id))
    clearTimeout(entry.timer)
    if (message.error !== undefined) {
      const data = message.error?.data && typeof message.error.data === 'object' ? message.error.data : {}
      entry.reject(new EngineError(typeof data.code === 'string' ? data.code : 'engine-error', String(message.error?.message ?? 'engine error'), data))
      return
    }
    entry.resolve(message.result)
  }

  /**
   * Fail every in-flight request when the process dies.
   * @param {number | null} code - exit code.
   * @param {string | null} signal - exit signal.
   * @returns {void}
   */
  #onExit(code, signal) {
    const tail = this.stderrTail.join('').trim()
    this.child = null
    this.ready = false
    this.#failAll(
      new EngineError('engine-exited', `the workflow engine exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})${tail.length > 0 ? `: ${tail.slice(-400)}` : ''}`, {
        exitCode: code,
        signal,
      }),
    )
  }

  /**
   * Reject every pending request with the same failure.
   * @param {EngineError} error - failure to surface.
   * @returns {void}
   */
  #failAll(error) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}

/**
 * Build a client from plugin config.
 * @param {{python: string, module?: string, cwd?: string, requestTimeoutMs?: number, startupTimeoutMs?: number, env?: Record<string, string>}} options - resolved settings.
 * @returns {EngineClient} a client that starts on first use.
 */
export function createEngineClient(options) {
  return new EngineClient(options)
}
