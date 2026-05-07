/* global window */
(function initModelsModule(globalScope) {
  const root = globalScope.EndoModules || (globalScope.EndoModules = {});

  root.createModelsModule = function createModelsModule(deps) {
    const {
      modelsList,
      modelsInstalledList,
      modelsModal,
      modelsStatus,
      modelsLocalSearch,
      modelRenderCacheLibrary,
      modelRenderCacheInstalled,
      escapeHtml,
      escapeAttr,
      api,
    } = deps;

    let loadModelsInFlight = false;
    let lastInstalledModels = [];

    function normalizeModelUiState(model) {
      const status = model.fileStatus || {};
      const progress = Number(status.progress || 0);
      const bytes = Number(status.expectedBytes || model.expectedBytes || 0);
      const sizeGB = bytes > 0 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB` : "?";
      const categoryLabel = { small: "Mały", medium: "Średni", large: "Duży" }[model.category] || "";
      const state = status.state || (status.available ? "completed" : "idle");
      return {
        ...model,
        ui: {
          state,
          progress,
          sizeGB,
          categoryLabel,
          downloaded: Number(status.downloaded || 0),
          total: Number(status.total || 0),
          error: status.error || "",
          isDownloaded: Boolean(status.available),
          isDownloading: state === "queued" || state === "downloading",
          isFailed: state === "failed",
        },
      };
    }

    function renderModelCard(model) {
      const { ui } = model;
      let badge = "";
      if (model.kind === "cloud-api") badge = '<span class="model-badge cloud">Cloud API</span>';
      else if (ui.isDownloaded) badge = '<span class="model-badge installed">Pobrany</span>';
      else if (ui.isDownloading) badge = '<span class="model-badge">Pobieranie...</span>';
      else if (ui.isFailed) badge = '<span class="model-badge error">Błąd pobierania</span>';
      else badge = '<span class="model-badge">Gotowy do pobrania</span>';

      const actions = [];
      if (model.kind !== "cloud-api") {
        if (ui.isDownloaded) {
          actions.push(`<button class="model-btn primary" onclick="useModel('${escapeAttr(model.id)}')">${model.selected ? "Aktywny" : "Użyj model"}</button>`);
          actions.push(`<button class="model-btn use" onclick="openSettingsModal('${escapeAttr(model.id)}')">Ustawienia</button>`);
          actions.push(`<button class="model-btn delete" onclick="deleteModel('${escapeAttr(model.id)}')">Usuń</button>`);
        } else if (ui.isDownloading) {
          actions.push(`<button class="model-btn download" disabled>${ui.state === "queued" ? "W kolejce..." : `Pobieranie ${ui.progress}%...`}</button>`);
          actions.push(`<button class="model-btn delete" onclick="cancelModelDownload('${escapeAttr(model.id)}')">Anuluj</button>`);
        } else {
          const cta = ui.isFailed ? "Ponów pobieranie" : `Pobierz (${ui.sizeGB})`;
          actions.push(`<button class="model-btn primary" onclick="downloadModel('${escapeAttr(model.id)}')">${cta}</button>`);
        }
      } else {
        actions.push(`<button class="model-btn primary" onclick="useModel('${escapeAttr(model.id)}')">${model.selected ? "Aktywny" : "Użyj model"}</button>`);
      }

      const contextLabel = model.contextTokens ? `${(model.contextTokens / 1024).toFixed(0)}k` : "—";
      const memoryLabel = ui.sizeGB || "—";
      const roleLabel = model.kind === "local-gguf" ? "Lokalny GGUF" : "API";
      const sourceLabel = model.sourceType || model.source || "unknown";
      const authorLabel = model.author || (typeof model.source === "string" ? model.source.split("/")[0] : "unknown");

      return `
    <article class="model-item ${model.selected ? "selected" : ""}" data-model-id="${escapeAttr(model.id)}" data-model-state="${escapeAttr(ui.state)}">
      <div class="model-info-header">
        <div class="model-main-info">
          <span class="model-name">${escapeHtml(model.displayName)}</span>
          <span class="model-id">${escapeHtml(model.id)}</span>
        </div>
        ${badge}
      </div>
      <div class="model-quick-stats">
        <div class="model-quick-stat"><span>Typ</span><strong>${escapeHtml(roleLabel)}</strong></div>
        <div class="model-quick-stat"><span>Rozmiar pliku</span><strong>${escapeHtml(memoryLabel)}</strong></div>
        <div class="model-quick-stat"><span>Kontekst</span><strong>${escapeHtml(contextLabel)}</strong></div>
      </div>
      <p class="model-desc">${escapeHtml(model.description || "Brak opisu modelu.")}</p>
      <div class="model-meta">
        <div class="model-meta-item"><span>Autor:</span> <strong>${escapeHtml(authorLabel)}</strong></div>
        <div class="model-meta-item"><span>Źródło:</span> <strong>${escapeHtml(String(sourceLabel))}</strong></div>
        ${ui.categoryLabel ? `<div class="model-meta-item"><span>Klasa:</span> <strong>${ui.categoryLabel}</strong></div>` : ""}
      </div>
      ${ui.isDownloading ? `<div class="download-progress-container"><div class="download-progress-fill" style="width:${ui.progress}%"></div></div>` : ""}
      ${ui.isFailed && ui.error ? `<div class="model-error">${escapeHtml(ui.error)}</div>` : ""}
      <div class="model-actions">${actions.join("")}</div>
    </article>
  `;
    }

    function filterModelsForTarget(models = [], targetEl = modelsList) {
      if (targetEl !== modelsList || !modelsLocalSearch) return models;
      const query = String(modelsLocalSearch.value || "").trim().toLowerCase();
      if (!query) return models;
      return models.filter((model) => {
        const haystack = [
          model.displayName,
          model.id,
          model.description,
          model.author,
          model.source,
          model.sourceType,
          model.kind,
        ].map((value) => String(value || "").toLowerCase()).join(" ");
        return haystack.includes(query);
      });
    }

    function renderModels(models = [], targetEl = modelsList, cacheMap = modelRenderCacheLibrary) {
      if (!targetEl) return;
      const visibleModels = filterModelsForTarget(models, targetEl);
      if (!visibleModels.length) {
        const hasQuery = targetEl === modelsList && String(modelsLocalSearch?.value || "").trim();
        targetEl.innerHTML = `<div class="models-empty">${hasQuery ? "Brak wyników dla wyszukiwania." : "Brak modeli w katalogu."}</div>`;
        cacheMap.clear();
        return;
      }
      const normalized = visibleModels.map(normalizeModelUiState);
      const nextIds = new Set(normalized.map((model) => model.id));
      for (const [id] of cacheMap) {
        if (!nextIds.has(id)) cacheMap.delete(id);
      }
      const html = [];
      for (const model of normalized) {
        const signature = JSON.stringify({
          id: model.id,
          selected: model.selected,
          state: model.ui.state,
          progress: model.ui.progress,
          available: model.ui.isDownloaded,
          error: model.ui.error,
          ctx: model.contextTokens,
        });
        cacheMap.set(model.id, signature);
        html.push(renderModelCard(model));
      }
      targetEl.innerHTML = html.join("");
    }

    function patchModelDownloadProgress(modelId, progress, downloaded = 0, total = 0) {
      const safeId = CSS.escape(String(modelId || ""));
      const cards = modelsModal ? modelsModal.querySelectorAll(`.model-item[data-model-id="${safeId}"]`) : [];
      cards.forEach((card) => {
        card.setAttribute("data-model-state", "downloading");
        let progressWrap = card.querySelector(".download-progress-container");
        if (!progressWrap) {
          progressWrap = document.createElement("div");
          progressWrap.className = "download-progress-container";
          progressWrap.innerHTML = `<div class="download-progress-fill" style="width:0%"></div>`;
          const actions = card.querySelector(".model-actions");
          if (actions?.parentNode) actions.parentNode.insertBefore(progressWrap, actions);
        }
        const fill = progressWrap.querySelector(".download-progress-fill");
        if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(progress) || 0))}%`;

        const actionBtn = card.querySelector(".model-btn.download");
        if (actionBtn) {
          actionBtn.disabled = true;
          actionBtn.textContent = `Pobieranie ${Math.max(0, Math.min(100, Number(progress) || 0))}%...`;
        }

        const downloadedMb = (Number(downloaded || 0) / 1024 / 1024).toFixed(0);
        const totalMb = Number(total || 0) > 0 ? `${(Number(total) / 1024 / 1024).toFixed(0)} MB` : "?? MB";
        const desc = card.querySelector(".model-desc");
        if (desc) {
          if (!desc.dataset.originalText) desc.dataset.originalText = desc.textContent || "";
          desc.textContent = `Pobieranie: ${downloadedMb} MB / ${totalMb}`;
        }
      });
    }

    async function loadModels() {
      if (!modelsList) return;
      if (loadModelsInFlight) return;
      loadModelsInFlight = true;
      modelsList.innerHTML = `<div class="models-empty">Ładowanie...</div>`;
      if (modelsInstalledList) modelsInstalledList.innerHTML = `<div class="models-empty">Ładowanie...</div>`;
      try {
        const models = await api.listModels();
        const installed = models.filter((model) => model.kind === "local-gguf" && model.fileStatus?.available);
        lastInstalledModels = installed;
        renderModels(installed, modelsList, modelRenderCacheLibrary);
        renderModels(installed, modelsInstalledList, modelRenderCacheInstalled);
      } catch (e) {
        modelsList.innerHTML = `<div class="models-empty error">${escapeHtml(e.message || String(e))}</div>`;
        if (modelsInstalledList) modelsInstalledList.innerHTML = `<div class="models-empty error">${escapeHtml(e.message || String(e))}</div>`;
      } finally {
        loadModelsInFlight = false;
      }
    }

    function setModelsStatus(text) {
      if (modelsStatus) modelsStatus.textContent = text;
    }

    if (modelsLocalSearch) {
      modelsLocalSearch.addEventListener("input", () => {
        renderModels(lastInstalledModels, modelsList, modelRenderCacheLibrary);
      });
    }

    return {
      renderModels,
      patchModelDownloadProgress,
      loadModels,
      setModelsStatus,
    };
  };
})(window);
