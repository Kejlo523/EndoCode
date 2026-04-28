function createRuntimeEngine(options = {}) {
  const {
    isServerReady,
    getServerModelId,
    stopOwnedServer,
    launchServerProcess,
    getModelConfig,
    getModelPath,
    getModelFileStatus,
    getModelSettingsForId,
    resetRuntimeRecoveryState = () => {},
    baselineMetrics,
    emit = () => {},
    getSelectedModelId = () => "",
    isServerOwned = () => false,
    getRunningModelId = () => null,
    getRunningContextTokens = () => null,
    getRunningGpuLayers = () => null,
    setRunningModelId = () => {},
    setRunningRuntimeConfig = () => {},
  } = options;

  async function ensureReady(port) {
    const selectedModelId = getSelectedModelId();
    const config = getModelConfig();
    const modelSettings = getModelSettingsForId(config?.id || selectedModelId);
    if (!config || config.kind !== "local-gguf") {
      throw new Error("Ten model nie jest lokalnym GGUF.");
    }

    const desiredContextTokens = Number(modelSettings.contextTokens ?? config.contextTokens ?? 8192);
    const desiredGpuLayers = Number(modelSettings.gpuLayers ?? config.gpuLayers ?? 99);

    if (await isServerReady(port)) {
      const liveModel = await getServerModelId(port);
      const expectedFile = config.file || "";
      const matchesCurrent = getRunningModelId() === selectedModelId ||
        liveModel === config.serverModel ||
        (liveModel && liveModel.includes(expectedFile));
      const ownedServer = Boolean(isServerOwned());
      const sameContext = Number(getRunningContextTokens()) === desiredContextTokens;
      const sameGpuLayers = Number(getRunningGpuLayers()) === desiredGpuLayers;
      const runtimeCompatible = !ownedServer || (sameContext && sameGpuLayers);
      if (matchesCurrent) {
        if (!runtimeCompatible && ownedServer) {
          emit("status", {
            status: "server-restart-required",
            detail: `Restart runtime: ctx ${getRunningContextTokens() || "?"} -> ${desiredContextTokens}, GPU ${getRunningGpuLayers() || 0} -> ${desiredGpuLayers}.`,
          });
          await stopOwnedServer();
        } else {
          if (!runtimeCompatible && !ownedServer) {
            throw new Error(
              `Aktywny serwer modelu działa z inną konfiguracją runtime. Użyj kill switcha i uruchom ponownie, aby zastosować ctx ${desiredContextTokens}.`,
            );
          }
          setRunningModelId(selectedModelId);
          setRunningRuntimeConfig({ contextTokens: desiredContextTokens, gpuLayers: desiredGpuLayers });
          emit("status", { status: "server-ready", detail: `Uzywam aktywnego serwera: ${config.displayName}.` });
          return;
        }
      }
      await stopOwnedServer();
    }

    const modelPath = getModelPath();
    const fileStatus = getModelFileStatus(config);
    if (!fileStatus.available) {
      const percent = Math.round((fileStatus.progress || 0) * 100);
      throw new Error(`Model nie jest jeszcze gotowy: ${config.displayName} (${percent}%).`);
    }

    const contextTokens = desiredContextTokens;
    const configuredGpuLayers = desiredGpuLayers;
    const gpuLayerAttempts = modelSettings.gpuLayers != null
      ? [configuredGpuLayers]
      : [...new Set([configuredGpuLayers, ...(config.gpuLayerFallbacks || [])])];
    const runtimeConfig = {
      ...config,
      threads: modelSettings.threads ?? config.threads,
      threadsBatch: modelSettings.threadsBatch ?? config.threadsBatch,
      batchSize: modelSettings.batchSize ?? config.batchSize,
      ubatchSize: modelSettings.ubatchSize ?? config.ubatchSize,
      parallel: modelSettings.parallel ?? config.parallel,
      flashAttention: modelSettings.flashAttention ?? config.flashAttention,
      cacheTypeK: modelSettings.cacheTypeK ?? config.cacheTypeK,
      cacheTypeV: modelSettings.cacheTypeV ?? config.cacheTypeV,
      fastStartup: modelSettings.fastStartup ?? config.fastStartup ?? true,
      reasoning: modelSettings.reasoning ?? config.reasoning,
      reasoningBudget: modelSettings.reasoningBudget ?? config.reasoningBudget,
      extraServerArgs: Array.isArray(modelSettings.extraServerArgs) ? modelSettings.extraServerArgs : config.extraServerArgs,
    };
    if (Number(configuredGpuLayers || 0) > 0) {
      // For GPU-heavy inference, too many CPU threads can degrade token latency.
      runtimeConfig.threads = Math.max(4, Math.min(Number(runtimeConfig.threads || 6), 8));
      runtimeConfig.threadsBatch = Math.max(
        runtimeConfig.threads,
        Math.min(Number(runtimeConfig.threadsBatch || (runtimeConfig.threads * 2)), 12),
      );
    }
    let lastError = null;
    for (let i = 0; i < gpuLayerAttempts.length; i += 1) {
      try {
        await launchServerProcess(runtimeConfig, modelPath, port, contextTokens, gpuLayerAttempts[i]);
        setRunningModelId(selectedModelId);
        setRunningRuntimeConfig({ contextTokens, gpuLayers: gpuLayerAttempts[i] });
        resetRuntimeRecoveryState(selectedModelId);
        return;
      } catch (error) {
        lastError = error;
        await stopOwnedServer({ force: true });
        const details = String(error?.message || "");
        if (runtimeConfig.fastStartup && /unknown|unrecognized|invalid option|no-warmup/i.test(details)) {
          runtimeConfig.fastStartup = false;
          baselineMetrics?.recordFallback?.("Server startup retry without --no-warmup");
          i -= 1;
          continue;
        }
        if (i < gpuLayerAttempts.length - 1) {
          baselineMetrics?.recordFallback?.(`GPU layers fallback ${gpuLayerAttempts[i]} -> ${gpuLayerAttempts[i + 1]}`);
          emit("status", {
            status: "server-starting",
            detail: `Start nie wyszedl (${error.message || String(error)}). Probuje GPU layers ${gpuLayerAttempts[i + 1]}.`,
          });
        }
      }
    }
    throw lastError || new Error("Nie udalo sie uruchomic modelu.");
  }

  return { ensureReady };
}

module.exports = { createRuntimeEngine };
