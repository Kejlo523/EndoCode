"use strict";

function createBaselineMetrics() {
  const state = {
    runs: [],
    backendLaunches: {},
    fallbackCount: 0,
    lastRuntime: null,
  };

  function recordRun(entry = {}) {
    state.runs.push({
      at: new Date().toISOString(),
      mode: entry.mode || "unknown",
      latencyMs: Number(entry.latencyMs || 0),
      ok: Boolean(entry.ok),
      backend: entry.backend || "unknown",
    });
    if (state.runs.length > 120) state.runs.shift();
  }

  function recordRuntimeLaunch(backend = "unknown", details = {}) {
    const key = String(backend || "unknown");
    state.backendLaunches[key] = (state.backendLaunches[key] || 0) + 1;
    state.lastRuntime = {
      at: new Date().toISOString(),
      backend: key,
      details,
    };
  }

  function recordFallback(reason = "") {
    state.fallbackCount += 1;
    state.lastFallbackReason = String(reason || "");
  }

  function getSummary() {
    const okRuns = state.runs.filter((run) => run.ok);
    const latencyList = okRuns.map((run) => run.latencyMs).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    const medianLatencyMs = latencyList.length ? latencyList[Math.floor(latencyList.length / 2)] : 0;
    return {
      totalRuns: state.runs.length,
      okRuns: okRuns.length,
      medianLatencyMs,
      backendLaunches: { ...state.backendLaunches },
      fallbackCount: state.fallbackCount,
      lastRuntime: state.lastRuntime,
      lastFallbackReason: state.lastFallbackReason || "",
    };
  }

  return {
    recordRun,
    recordRuntimeLaunch,
    recordFallback,
    getSummary,
  };
}

module.exports = { createBaselineMetrics };
