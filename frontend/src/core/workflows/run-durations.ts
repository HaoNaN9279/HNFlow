/**
 * Node execution durations (N14x) read from a run's checkpoint channels.
 *
 * The backend compiler times each node's *work* segment and writes the result
 * on the reserved channel `wf:<node_id>:__duration_ms` (replayed nodes write
 * nothing — they did no work). The run-state endpoint returns the `wf:*`
 * channels, so the canvas can surface real per-node timings without a
 * dedicated endpoint or a widened node-event contract.
 *
 * Pure: takes the channel map, returns a report. No fetching, no React.
 */

/** One node's measured execution time. */
export type NodeDuration = {
  nodeId: string;
  /** Wall-clock milliseconds reported by the engine (0 for a near-instant node). */
  ms: number;
};

export type NodeDurationReport = {
  /** Per-node durations keyed by node id. */
  durations: Record<string, number>;
  /** Sum of every measured node (not the run's wall-clock). */
  totalMs: number;
  /** The slowest node, or null when nothing was measured. */
  slowest: NodeDuration | null;
};

const DURATION_SUFFIX = ":__duration_ms";
const CHANNEL_PREFIX = "wf:";

const EMPTY: NodeDurationReport = { durations: {}, totalMs: 0, slowest: null };

/**
 * Extract every `wf:<node>:__duration_ms` channel into a duration report.
 *
 * Ties on the slowest node break on the node id so the readout is stable
 * across renders. Non-numeric values (a hand-written or legacy channel) are
 * skipped rather than coerced to 0, which would report a fake measurement.
 */
export function extractNodeDurations(
  channels: Record<string, unknown> | null | undefined,
): NodeDurationReport {
  if (!channels) {
    return EMPTY;
  }

  const durations: Record<string, number> = {};
  let slowest: NodeDuration | null = null;
  let totalMs = 0;

  for (const [key, value] of Object.entries(channels)) {
    if (!key.startsWith(CHANNEL_PREFIX) || !key.endsWith(DURATION_SUFFIX)) {
      continue;
    }
    const nodeId = key.slice(CHANNEL_PREFIX.length, -DURATION_SUFFIX.length);
    if (!nodeId) {
      continue;
    }
    const ms = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(ms)) {
      continue;
    }
    durations[nodeId] = ms;
    totalMs += ms;
    if (
      slowest === null ||
      ms > slowest.ms ||
      (ms === slowest.ms && nodeId < slowest.nodeId)
    ) {
      slowest = { nodeId, ms };
    }
  }

  if (slowest === null) {
    return EMPTY;
  }
  return { durations, totalMs, slowest };
}

/** Format a duration for display: sub-second values keep one decimal. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "";
  }
  if (ms < 1000) {
    return `${Math.round(ms * 10) / 10} ms`;
  }
  return `${Math.round(ms / 100) / 10} s`;
}
