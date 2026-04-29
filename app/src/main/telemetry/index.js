const { execSync, exec, spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const { promisify } = require("node:util");
const execAsync = promisify(exec);

function createTelemetryMonitor() {
  let previousCpuInfo = os.cpus();
  let nvidiaSmiAvailable = null;
  let lastGpuProbeAt = 0;
  let gpuProbeCache = { gpuPercent: -1, vramUsedMB: -1, vramTotalMB: -1, gpuVendor: "unknown", gpuName: "" };
  const GPU_PROBE_INTERVAL_MS = 30000;
  const GPU_PROBE_FAIL_BACKOFF_MS = 60000;
  const GPU_SYNC_PROBE_INTERVAL_MS = 60000;
  const GPU_SYNC_PROBE_FAIL_BACKOFF_MS = 120000;
  let cachedModelProfile = null;
  let cachedModelProfileAt = 0;
  let gpuProbeInFlight = false;
  let nextGpuProbeAt = 0;
  let nextSyncGpuProbeAt = 0;

  function detectVendor(name = "") {
    const normalized = String(name).toLowerCase();
    if (normalized.includes("nvidia") || normalized.includes("geforce") || normalized.includes("quadro")) return "nvidia";
    if (
      normalized.includes("amd")
      || normalized.includes("radeon")
      || normalized.includes("ati")
      || normalized.includes("advanced micro devices")
    ) return "amd";
    if (
      normalized.includes("intel")
      || normalized.includes("arc")
      || normalized.includes("iris")
      || normalized.includes("uhd")
    ) return "intel";
    return "unknown";
  }

  function normalizeGpuCards(cards) {
    const list = Array.isArray(cards) ? cards : cards ? [cards] : [];
    return list
      .filter((card) => card && typeof card === "object")
      .map((card) => ({
        name: String(card.Name ?? card.name ?? "").trim(),
        adapterRAM: Number(card.AdapterRAM ?? card.adapterRAM ?? 0),
      }))
      .filter((card) => card.name);
  }

  function pickPrimaryGpuCard(cards) {
    const vendorPriority = { nvidia: 3, amd: 3, intel: 2, unknown: 1 };
    return normalizeGpuCards(cards)
      .sort((left, right) => {
        const leftVirtual = /microsoft basic render|remote display|virtual/i.test(left.name) ? 0 : 1;
        const rightVirtual = /microsoft basic render|remote display|virtual/i.test(right.name) ? 0 : 1;
        if (rightVirtual !== leftVirtual) return rightVirtual - leftVirtual;
        const leftVendor = detectVendor(left.name);
        const rightVendor = detectVendor(right.name);
        const leftPriority = vendorPriority[leftVendor] || 0;
        const rightPriority = vendorPriority[rightVendor] || 0;
        if (rightPriority !== leftPriority) return rightPriority - leftPriority;
        return (Number(right.adapterRAM) || 0) - (Number(left.adapterRAM) || 0);
      })[0] || null;
  }

  function parseWindowsGpuSnapshot(snapshot = {}) {
    const cards = normalizeGpuCards(snapshot.cards);
    const primaryCard = pickPrimaryGpuCard(cards);
    const fallbackVramBytes = cards
      .map((card) => Number(card.adapterRAM || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => b - a)[0] || 0;
    const primaryVramBytes = Number(primaryCard?.adapterRAM || 0);
    const totalVramBytes = primaryVramBytes > 0 ? primaryVramBytes : fallbackVramBytes;
    const util = Number(snapshot.utilization);
    const used = Number(snapshot.dedicatedUsedMB);
    return {
      gpuPercent: Number.isFinite(util) ? Math.max(0, Math.min(100, Math.round(util))) : -1,
      vramUsedMB: Number.isFinite(used) && used >= 0 ? Math.round(used) : -1,
      vramTotalMB: totalVramBytes > 0 ? Math.round(totalVramBytes / (1024 * 1024)) : -1,
      gpuVendor: detectVendor(primaryCard?.name || ""),
      gpuName: String(primaryCard?.name || ""),
    };
  }

  async function runPowerShellScript(script, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const child = spawn("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
      }, timeout);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error((stderr || stdout || "PowerShell failed").trim()));
      });
    });
  }

  function runPowerShellScriptSync(script, timeout = 5000) {
    const result = spawnSync("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], {
      windowsHide: true,
      encoding: "utf8",
      timeout,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || "PowerShell failed").trim());
    }
    return String(result.stdout || "").trim();
  }

  async function probeWindowsGpuSnapshot() {
    // One PowerShell call to reduce overhead and improve AMD coverage.
    const script = "$cards = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object Name,AdapterRAM;" +
      "$eng = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue;" +
      "$mem = Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue;" +
      "$util = 0;" +
      "if ($eng -and $eng.CounterSamples) { $u = ($eng.CounterSamples | Measure-Object -Property CookedValue -Average).Average; if ($u) { $util = [math]::Round($u,0) } };" +
      "$used = 0;" +
      "if ($mem -and $mem.CounterSamples) { $m = ($mem.CounterSamples | Measure-Object -Property CookedValue -Maximum).Maximum; if ($m) { $used = [math]::Round($m / 1MB,0) } };" +
      "$out = [PSCustomObject]@{ cards=$cards; utilization=$util; dedicatedUsedMB=$used };" +
      "$out | ConvertTo-Json -Compress";
    const stdout = await runPowerShellScript(script, 35000);
    return JSON.parse(String(stdout || "").trim() || "{}");
  }

  function probeWindowsGpuSnapshotSync() {
    const script = "$cards = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object Name,AdapterRAM;" +
      "$out = [PSCustomObject]@{ cards=$cards };" +
      "$out | ConvertTo-Json -Compress";
    const stdout = runPowerShellScriptSync(script, 5000);
    return JSON.parse(String(stdout || "").trim() || "{}");
  }

  function probeGpuInfo() {
    // Synchronous path is used only by install/runtime decisions.
    // Keep it lightweight to avoid UI stalls.
    if (nvidiaSmiAvailable !== false) {
      try {
        const out = execSync("nvidia-smi --query-gpu=name,utilization.gpu,memory.total --format=csv,noheader,nounits", {
          timeout: 500,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        }).toString().trim();
        const firstRow = out.split(/\r?\n/).find((line) => line.trim()) || "";
        const parts = firstRow.split(",").map((s) => s.trim());
        gpuProbeCache = {
          ...gpuProbeCache,
          gpuVendor: "nvidia",
          gpuName: String(parts[0] || gpuProbeCache.gpuName || "NVIDIA"),
          gpuPercent: Number.parseInt(parts[1], 10) || gpuProbeCache.gpuPercent,
          vramTotalMB: Number.parseInt(parts[2], 10) || gpuProbeCache.vramTotalMB,
        };
        return { ...gpuProbeCache };
      } catch {
        nvidiaSmiAvailable = false;
      }
    }
    if (process.platform === "win32") {
      const now = Date.now();
      const needsSyncProbe = gpuProbeCache.gpuVendor === "unknown" || Number(gpuProbeCache.vramTotalMB || 0) <= 0;
      if (needsSyncProbe && now >= nextSyncGpuProbeAt) {
        try {
          const snapshot = probeWindowsGpuSnapshotSync();
          const nextProbe = parseWindowsGpuSnapshot(snapshot);
          gpuProbeCache = {
            ...gpuProbeCache,
            ...nextProbe,
            gpuPercent: nextProbe.gpuPercent >= 0 ? nextProbe.gpuPercent : gpuProbeCache.gpuPercent,
            vramUsedMB: nextProbe.vramUsedMB >= 0 ? nextProbe.vramUsedMB : gpuProbeCache.vramUsedMB,
          };
          nextSyncGpuProbeAt = now + GPU_SYNC_PROBE_INTERVAL_MS;
        } catch {
          nextSyncGpuProbeAt = now + GPU_SYNC_PROBE_FAIL_BACKOFF_MS;
        }
      }
    }
    return { ...gpuProbeCache };
  }

  async function probeGpuInfoAsync() {
    let gpuPercent = -1;
    let vramUsedMB = -1;
    let vramTotalMB = -1;
    let gpuVendor = "unknown";
    let gpuName = "";
    if (nvidiaSmiAvailable !== false) {
      try {
        const { stdout } = await execAsync("nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits", {
          timeout: 1500,
          windowsHide: true,
        });
        const out = String(stdout || "").trim();
        const firstRow = out.split(/\r?\n/).find((line) => line.trim()) || "";
        const parts = firstRow.split(",").map((s) => s.trim());
        gpuName = String(parts[0] || "");
        gpuPercent = parseInt(parts[1], 10) || 0;
        vramUsedMB = parseInt(parts[2], 10) || 0;
        vramTotalMB = parseInt(parts[3], 10) || 0;
        gpuVendor = "nvidia";
        nvidiaSmiAvailable = true;
      } catch {
        nvidiaSmiAvailable = false;
      }
    }

    if (nvidiaSmiAvailable === false && process.platform === "win32") {
      try {
        const snapshot = await probeWindowsGpuSnapshot();
        if (snapshot && snapshot.cards) {
          const parsed = parseWindowsGpuSnapshot(snapshot);
          gpuName = String(parsed.gpuName || gpuName || "");
          gpuVendor = parsed.gpuVendor || gpuVendor;
          if (parsed.vramTotalMB > 0) vramTotalMB = parsed.vramTotalMB;
          if (parsed.gpuPercent >= 0) gpuPercent = parsed.gpuPercent;
          if (parsed.vramUsedMB >= 0) vramUsedMB = parsed.vramUsedMB;
        }
      } catch {}
      if (gpuPercent < 0) {
        try {
          const out = await runPowerShellScript(
            "$g = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue; if ($g) { [math]::Round((($g | Measure-Object -Property UtilizationPercentage -Average).Average),0) } else { 0 }",
            10000,
          );
          const value = Number.parseFloat(String(out || "").trim());
          if (Number.isFinite(value)) gpuPercent = Math.max(0, Math.min(100, Math.round(value)));
        } catch {}
      }
    }

    if (gpuVendor !== "unknown" && gpuPercent < 0) gpuPercent = 0;
    if (vramTotalMB > 0 && vramUsedMB < 0) vramUsedMB = 0;
    return { gpuPercent, vramUsedMB, vramTotalMB, gpuVendor, gpuName };
  }

  function scheduleGpuProbe(force = false) {
    const now = Date.now();
    if (!force && (gpuProbeInFlight || (nextGpuProbeAt > 0 && now < nextGpuProbeAt))) return;
    gpuProbeInFlight = true;
    void probeGpuInfoAsync()
      .then((nextProbe) => {
        gpuProbeCache = {
          ...gpuProbeCache,
          ...nextProbe,
          vramUsedMB: nextProbe.vramUsedMB >= 0 ? nextProbe.vramUsedMB : gpuProbeCache.vramUsedMB,
        };
        lastGpuProbeAt = Date.now();
        nextGpuProbeAt = Date.now() + GPU_PROBE_INTERVAL_MS;
      })
      .catch(() => {
        nextGpuProbeAt = Date.now() + GPU_PROBE_FAIL_BACKOFF_MS;
      })
      .finally(() => {
        gpuProbeInFlight = false;
      });
  }

  function getSystemInfo() {
    const cpus = os.cpus();
    let cpuPercent = 0;
    if (previousCpuInfo && previousCpuInfo.length === cpus.length) {
      let totalIdle = 0;
      let totalTick = 0;
      for (let i = 0; i < cpus.length; i += 1) {
        const prev = previousCpuInfo[i].times;
        const curr = cpus[i].times;
        const idle = curr.idle - prev.idle;
        const total = (curr.user - prev.user) + (curr.nice - prev.nice) + (curr.sys - prev.sys) + (curr.irq - prev.irq) + idle;
        totalIdle += idle;
        totalTick += total;
      }
      cpuPercent = totalTick > 0 ? Math.round(((totalTick - totalIdle) / totalTick) * 100) : 0;
    }
    previousCpuInfo = cpus;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ramPercent = Math.round((usedMem / totalMem) * 100);
    scheduleGpuProbe();

    return {
      cpu: cpuPercent,
      gpu: gpuProbeCache.gpuPercent,
      gpuVendor: gpuProbeCache.gpuVendor,
      gpuName: gpuProbeCache.gpuName,
      ramPercent,
      ramUsedGB: (usedMem / 1073741824).toFixed(1),
      ramTotalGB: (totalMem / 1073741824).toFixed(1),
      vramUsedMB: gpuProbeCache.vramUsedMB,
      vramTotalMB: gpuProbeCache.vramTotalMB,
      vramPercent: gpuProbeCache.vramTotalMB > 0 && gpuProbeCache.vramUsedMB >= 0
        ? Math.round((gpuProbeCache.vramUsedMB / gpuProbeCache.vramTotalMB) * 100)
        : -1,
    };
  }

  function getHardwareModelProfile() {
    const info = getSystemInfo();
    const syncGpuInfo = probeGpuInfo();
    const resolvedGpuVendor = syncGpuInfo.gpuVendor && syncGpuInfo.gpuVendor !== "unknown"
      ? String(syncGpuInfo.gpuVendor)
      : String(info.gpuVendor || "unknown");
    const resolvedGpuName = String(syncGpuInfo.gpuName || info.gpuName || "");
    const resolvedGpuPercent = syncGpuInfo.gpuPercent >= 0 ? syncGpuInfo.gpuPercent : info.gpu;
    const resolvedVramTotalMB = syncGpuInfo.vramTotalMB > 0 ? syncGpuInfo.vramTotalMB : Number(info.vramTotalMB || 0);
    const resolvedVramUsedMB = syncGpuInfo.vramUsedMB >= 0 ? syncGpuInfo.vramUsedMB : Number(info.vramUsedMB || 0);
    const resolvedInfo = {
      ...info,
      gpu: resolvedGpuPercent,
      gpuVendor: resolvedGpuVendor,
      gpuName: resolvedGpuName,
      vramTotalMB: resolvedVramTotalMB,
      vramUsedMB: resolvedVramUsedMB,
      vramPercent: resolvedVramTotalMB > 0 && resolvedVramUsedMB >= 0
        ? Math.round((resolvedVramUsedMB / resolvedVramTotalMB) * 100)
        : -1,
    };
    const ramGB = Number(resolvedInfo.ramTotalGB) || Math.round(os.totalmem() / 1073741824);
    const vramGB = resolvedInfo.vramTotalMB > 0 ? resolvedInfo.vramTotalMB / 1024 : 0;
    let target = "1B-3B Q4";
    let maxParamB = 3;
    if (vramGB >= 20 || ramGB >= 64) {
      target = "14B-30B Q4";
      maxParamB = 30;
    } else if (vramGB >= 11 || ramGB >= 32) {
      target = "7B-14B Q4/Q5";
      maxParamB = 14;
    } else if (vramGB >= 6 || ramGB >= 16) {
      target = "3B-8B Q4/Q5";
      maxParamB = 8;
    }
    return {
      ...resolvedInfo,
      ramGB,
      vramGB,
      target,
      maxParamB,
      memoryBudgetGB: Math.max(2, ramGB * 0.55),
      fastBudgetGB: vramGB > 0 ? Math.max(1, vramGB * 0.85) : 0,
      gpuVendor: resolvedInfo.gpuVendor || "unknown",
      gpuBackendClass: resolvedInfo.gpuVendor === "nvidia" ? "nvidia" : resolvedInfo.gpuVendor === "amd" ? "amd" : resolvedInfo.gpuVendor === "intel" ? "intel-igpu" : "cpu-only",
      hasDedicatedGpu: vramGB > 0,
    };
  }

  function getCachedModelProfile() {
    const now = Date.now();
    if (!cachedModelProfile || now - cachedModelProfileAt > 60000) {
      cachedModelProfile = getHardwareModelProfile();
      cachedModelProfileAt = now;
    }
    return cachedModelProfile;
  }

  // Warm up async probe after startup, but don't block startup path.
  setTimeout(() => scheduleGpuProbe(true), 500);

  return { probeGpuInfo, getSystemInfo, getHardwareModelProfile, getCachedModelProfile };
}

module.exports = { createTelemetryMonitor };
