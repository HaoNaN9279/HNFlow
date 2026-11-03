/**
 * An in-process stand-in for a spawned engine process.
 *
 * The DSH Windows sandbox denies piped `spawn` (EPERM), so the transport tests
 * drive the real client code over a fake pipe: same framing, same callbacks,
 * no OS pipe. The responder mirrors `deerflow.workflow.rpc`'s line protocol.
 */

import { EventEmitter } from 'node:events'

/**
 * A readable side that emits `data` events with text chunks.
 */
class FakeReadable extends EventEmitter {
  /** @returns {void} */
  setEncoding() {
    // The real stream decodes; the fake already emits strings.
  }

  /**
   * Emit one chunk asynchronously, like a pipe delivering bytes.
   * @param {string} text - payload.
   * @returns {void}
   */
  push(text) {
    setImmediate(() => this.emit('data', text))
  }
}

/**
 * A child process facade with `stdin`/`stdout`/`stderr` and lifecycle events.
 */
export class FakeChild extends EventEmitter {
  /**
   * @param {{responder?: (message: Record<string, any>, child: FakeChild) => void}} [options] - request handler.
   */
  constructor(options = {}) {
    super()
    this.stdout = new FakeReadable()
    this.stderr = new FakeReadable()
    this.exited = false
    const respond = options.responder ?? defaultResponder
    this.stdin = {
      destroyed: false,
      /**
       * Accept a frame.
       * @param {string} payload - JSON line.
       * @param {(error: Error | null) => void} [callback] - write callback.
       * @returns {void}
       */
      write: (payload, callback) => {
        if (this.exited) {
          callback?.(new Error('EPIPE'))
          return
        }
        for (const line of String(payload).split('\n')) {
          if (line.trim().length === 0) continue
          setImmediate(() => respond(JSON.parse(line), this))
        }
        callback?.(null)
      },
      /**
       * Close stdin, optionally writing a last frame first.
       * @param {string} [payload] - final frame.
       * @returns {void}
       */
      end: (payload) => {
        if (typeof payload === 'string' && payload.trim().length > 0) {
          for (const line of payload.split('\n')) {
            if (line.trim().length === 0) continue
            setImmediate(() => respond(JSON.parse(line), this))
          }
        }
      },
    }
  }

  /**
   * Write one JSON-RPC frame to stdout.
   * @param {Record<string, unknown>} message - frame.
   * @returns {void}
   */
  reply(message) {
    if (this.exited) return
    this.stdout.push(`${JSON.stringify(message)}\n`)
  }

  /**
   * Terminate the fake process.
   * @param {number} code - exit code.
   * @returns {void}
   */
  exitNow(code) {
    if (this.exited) return
    this.exited = true
    setImmediate(() => this.emit('exit', code, null))
  }

  /**
   * Request termination (ignored: the fake exits on its own schedule).
   * @returns {void}
   */
  kill() {
    this.exitNow(0)
  }
}

/**
 * The default method table.
 * @param {Record<string, any>} message - decoded request.
 * @param {FakeChild} child - the fake process.
 * @returns {void}
 */
export function defaultResponder(message, child) {
  const id = message.id
  switch (message.method) {
    case 'engine/initialize':
      child.reply({ jsonrpc: '2.0', id, result: { protocolVersion: 1, engine: { name: 'fake-engine' }, capabilities: { humanTasks: false }, workflow: { schemaVersion: 1, nodeTypes: [], portTypes: [] } } })
      return
    case 'engine/ping':
      child.reply({ jsonrpc: '2.0', id, result: { pong: true } })
      return
    case 'echo/fail':
      child.reply({ jsonrpc: '2.0', id, error: { code: -32000, message: 'nope', data: { code: 'boom' } } })
      return
    case 'echo/slow':
      setTimeout(() => child.reply({ jsonrpc: '2.0', id, result: { slept: true } }), 200)
      return
    case 'echo/notify':
      child.reply({ jsonrpc: '2.0', method: 'run/status', params: { runId: 'run-1', status: 'running' } })
      child.reply({ jsonrpc: '2.0', id, result: { notified: true } })
      return
    case 'echo/garbage':
      child.stdout.push('this is not json\n')
      child.reply({ jsonrpc: '2.0', id, result: { survived: true } })
      return
    case 'echo/crash':
      child.exitNow(3)
      return
    case 'engine/shutdown':
      child.reply({ jsonrpc: '2.0', id, result: { ok: true } })
      child.exitNow(0)
      return
    default:
      child.reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method' } })
  }
}
