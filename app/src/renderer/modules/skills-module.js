/* global window */
(function initSkillsModule(globalScope) {
  const root = globalScope.EndoModules || (globalScope.EndoModules = {});

  root.createSkillsModule = function createSkillsModule(deps) {
    const { skillsList, skillsCount, skillRenderCache, escapeHtml, api } = deps;

    function renderSkills(skills = []) {
      if (!skillsList) return;
      const normalized = skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        category: skill.category,
        summary: skill.summary,
        installed: Boolean(skill.installed),
        localOnly: skill.localOnly !== false,
      }));
      if (!normalized.some((skill) => skill.id === "vision")) {
        normalized.push({
          id: "vision",
          name: "Vision (VLM Support)",
          category: "Zdolności Agenta",
          summary: "Włącza obsługę załączników obrazów oraz narzędzie analize_image.",
          installed: false,
          localOnly: true,
        });
      }
      normalized.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
      const installedCount = normalized.filter((skill) => skill.installed).length;
      if (skillsCount) skillsCount.textContent = `${installedCount} / ${normalized.length} aktywnych`;
      if (!normalized.length) {
        skillsList.innerHTML = `<div class="skills-empty">Brak lokalnych skilli.</div>`;
        return;
      }
      skillsList.innerHTML = normalized.map((skill) => `
    <article class="skill-card ${skill.installed ? "installed" : ""}">
      <div class="skill-card-main">
        <div class="skill-card-top">
          <span class="skill-name">${escapeHtml(skill.name)}</span>
          <span class="skill-category">${escapeHtml(skill.category)}</span>
        </div>
        <p class="skill-summary">${escapeHtml(skill.summary)}</p>
        <div class="skill-local">${skill.localOnly ? "local-only" : "online"}</div>
      </div>
      <div class="skill-actions">
        <span class="skill-state ${skill.installed ? "installed" : "available"}">${skill.installed ? "Aktywny" : "Dostępny"}</span>
        <button class="skill-install-btn ${skill.installed ? "installed" : ""}" data-skill-id="${escapeHtml(skill.id)}" data-action="${skill.installed ? "uninstall" : "install"}">
          ${skill.installed ? "Usuń" : "Instaluj"}
        </button>
      </div>
    </article>
  `).join("");
      skillRenderCache.clear();
      normalized.forEach((skill) => skillRenderCache.set(skill.id, JSON.stringify(skill)));
    }

    async function loadSkills() {
      if (!skillsList) return;
      skillsList.innerHTML = `<div class="skills-empty">Ładowanie...</div>`;
      try {
        renderSkills(await api.listSkills());
      } catch (e) {
        skillsList.innerHTML = `<div class="skills-empty error">${escapeHtml(e.message || String(e))}</div>`;
      }
    }

    return { renderSkills, loadSkills };
  };
})(window);
