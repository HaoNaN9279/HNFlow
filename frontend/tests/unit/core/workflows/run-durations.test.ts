/**
 * Tests for `@/core/workflows/run-durations` — the N14x timing readout read
 * from a run's checkpoint channels.
 */

import { describe, expect, it } from "@rstest/core";

import {
  extractNodeDurations,
  formatDuration,
} from "@/core/workflows/run-durations";

describe("extractNodeDurations", () => {
  it("reads only the reserved duration channels", () => {
    const report = extractNodeDurations({
      "wf:a:__duration_ms": 12.5,
      "wf:b:__duration_ms": 300,
      "wf:a:out": "text",
      "wf:shared:board": 1,
      other: 5,
    });
    expect(report.durations).toEqual({ a: 12.5, b: 300 });
    expect(report.totalMs).toBe(312.5);
    expect(report.slowest).toEqual({ nodeId: "b", ms: 300 });
  });

  it("returns an empty report for no channels", () => {
    expect(extractNodeDurations(null)).toEqual({
      durations: {},
      totalMs: 0,
      slowest: null,
    });
    expect(extractNodeDurations({})).toEqual({
      durations: {},
      totalMs: 0,
      slowest: null,
    });
  });

  it("skips non-numeric values rather than reporting a fake measurement", () => {
    const report = extractNodeDurations({
      "wf:a:__duration_ms": "nope",
      "wf:b:__duration_ms": 4,
      "wf::__duration_ms": 9,
    });
    expect(report.durations).toEqual({ b: 4 });
    expect(report.slowest).toEqual({ nodeId: "b", ms: 4 });
  });

  it("accepts numeric strings (JSON round-trip)", () => {
    expect(
      extractNodeDurations({ "wf:a:__duration_ms": "7.5" }).durations,
    ).toEqual({ a: 7.5 });
  });

  it("breaks a slowest tie on the node id for a stable readout", () => {
    expect(
      extractNodeDurations({
        "wf:b:__duration_ms": 5,
        "wf:a:__duration_ms": 5,
      }).slowest,
    ).toEqual({ nodeId: "a", ms: 5 });
  });

  it("ignores channels whose node id is empty", () => {
    expect(extractNodeDurations({ "wf::__duration_ms": 3 }).durations).toEqual(
      {},
    );
  });

  it("keeps a zero measurement (a node really ran)", () => {
    const report = extractNodeDurations({ "wf:a:__duration_ms": 0 });
    expect(report.durations).toEqual({ a: 0 });
    expect(report.slowest).toEqual({ nodeId: "a", ms: 0 });
  });
});

describe("formatDuration", () => {
  it("keeps sub-second values in milliseconds with one decimal", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(12.34)).toBe("12.3 ms");
    expect(formatDuration(999)).toBe("999 ms");
  });

  it("switches to seconds at one second", () => {
    expect(formatDuration(1000)).toBe("1 s");
    expect(formatDuration(1234)).toBe("1.2 s");
  });

  it("returns an empty string for a non-finite value", () => {
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
  });
});
