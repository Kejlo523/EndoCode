"use strict";

function detectInstallTarget(platform, gpuInfo = {}) {
  const gpuVendor = String(gpuInfo?.gpuVendor || "unknown").toLowerCase();
  let runtimePreference = ["cpu"];
  if (platform === "linux") {
    if (gpuVendor === "nvidia") runtimePreference = ["cuda", "vulkan", "cpu"];
    else if (gpuVendor === "amd") runtimePreference = ["rocm", "vulkan", "cpu"];
    else runtimePreference = ["vulkan", "cpu"];
  } else {
    if (gpuVendor === "nvidia") runtimePreference = ["cuda", "vulkan", "cpu"];
    else runtimePreference = ["cpu", "vulkan", "cuda"];
  }
  return { platform, gpuVendor, runtimePreference };
}

function rankRuntimeAssets(assets, target) {
  if (!Array.isArray(assets) || assets.length === 0) return [];
  const platformToken = target.platform === "linux" ? "-bin-linux-" : "-bin-win-";
  const requiredExt = target.platform === "linux" ? [".zip", ".tar.gz", ".tgz"] : [".zip"];
  const candidates = assets.filter((asset) => {
    const name = String(asset?.name || "").toLowerCase();
    const extOk = requiredExt.some((ext) => name.endsWith(ext));
    return extOk && name.startsWith("llama-") && name.includes(platformToken) && name.includes("x64") && !name.includes("arm") && !name.startsWith("cudart-");
  });
  if (!candidates.length) return [];

  const scoreAsset = (asset) => {
    const name = String(asset?.name || "").toLowerCase();
    let score = 0;
    if (name.includes("llama-")) score += 20;
    if (name.includes(platformToken)) score += 20;
    for (let i = 0; i < target.runtimePreference.length; i += 1) {
      const backend = target.runtimePreference[i];
      const backendScore = Math.max(0, 60 - i * 20);
      if (backend === "rocm" && (name.includes("rocm") || name.includes("hip"))) score += backendScore;
      if (backend !== "rocm" && name.includes(backend)) score += backendScore;
    }
    if (!name.includes("cuda") && !name.includes("vulkan") && !name.includes("rocm") && !name.includes("hip")) score += 8;
    return score;
  };

  return candidates.sort((a, b) => scoreAsset(b) - scoreAsset(a));
}

function inferBackendFromAssetName(assetName = "") {
  const name = String(assetName || "").toLowerCase();
  if (name.includes("cuda")) return "cuda";
  if (name.includes("rocm") || name.includes("hip")) return "rocm";
  if (name.includes("vulkan")) return "vulkan";
  return "cpu";
}

function inferBackendFromLogs(logText = "") {
  const text = String(logText || "").toLowerCase();
  if (!text) return "unknown";
  if (/(cuda|cublas|cu\\d|nvidia)/i.test(text)) return "cuda";
  if (/(vulkan|vkcreateinstance)/i.test(text)) return "vulkan";
  if (/(rocm|hipblas|amd)/i.test(text)) return "rocm";
  if (/(cpu backend|ggml backend.*cpu|using cpu)/i.test(text)) return "cpu";
  return "unknown";
}

module.exports = {
  detectInstallTarget,
  rankRuntimeAssets,
  inferBackendFromAssetName,
  inferBackendFromLogs,
};
