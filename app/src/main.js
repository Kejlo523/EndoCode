const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawn, execSync } = require("node:child_process");
const crypto = require("node:crypto");
const os = require("node:os");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const https = require("node:https");

const DEFAULT_PORT = 8088;
const MAX_FILE_BYTES = 220000;
const MODEL_JSON_RETRY_LIMIT = 2;
const MODEL_CALL_RETRY_LIMIT = 1;
const MODEL_STREAM_IDLE_TIMEOUT_MS = 6 * 60 * 1000;
const SERVER_SHUTDOWN_TIMEOUT_MS = 6000;
let MAX_MESSAGES = 32;

const REASONING_LEVELS = {
  low: {
    label: "Szybko",
    maxSteps: 8,
    maxTokens: 900,
    temperature: 0.1,
    instruction: "Dzialaj szybko. Rob minimalny plan i wykonuj najprostszy bezpieczny krok.",
  },
  medium: {
    label: "Normalnie",
    maxSteps: 14,
    maxTokens: 1300,
    temperature: 0.2,
    instruction: "Zrob krotki plan, sprawdz istotne pliki i pracuj krok po kroku.",
  },
  high: {
    label: "Dokladnie",
    maxSteps: 24,
    maxTokens: 1900,
    temperature: 0.2,
    instruction: "Poswiec wiecej krokow na rozpoznanie, weryfikacje i testy. Note ma streszczac decyzje, nie ukryty tok myslenia.",
  },
  max: {
    label: "Maksymalnie",
    maxSteps: 36,
    maxTokens: 2600,
    temperature: 0.25,
    instruction: "Pracuj bardzo dokladnie: plan, eksploracja, male edycje, testy i korekty. Note ma byc jawna i zwiezla.",
  },
};

const BASE_SYSTEM_PROMPT = `Jestes lokalnym agentem kodujacym w stylu Codex.
Masz sandbox plikowy i mozesz pracowac tylko przez jawne narzedzia. UI pokazuje uzytkownikowi kazdy krok.

Odpowiadaj wylacznie pojedynczym JSON-em.

Gdy chcesz wykonac akcje:
{"note":"krotka jawna notatka co robisz i dlaczego","tool":"ls","args":{"path":".","maxEntries":100}}

Dostepne narzedzia:
- pwd {}
- cd {"path":"folder"}
- ls {"path":".","maxEntries":100}
- analyze_image {"path":"plik.jpg"}
- read_file {"path":"plik","maxBytes":30000}
- write_file {"path":"plik","content":"...","mode":"overwrite albo append"}
- mkdir {"path":"folder"}
- replace_text {"path":"plik","old":"tekst","new":"tekst","count":1}
- create_pdf {"path":"raport.pdf","title":"Tytul","markdown":"# Tresc"} albo {"path":"raport.pdf","title":"Tytul","html":"<h1>Tresc</h1>"}
- run_powershell {"command":"npm test","timeout":60}
- fetch_url {"url":"https://example.com"}
- extract_media {"url":"https://example.com"}
- download_file {"url":"https://example.com/file.zip","path":"plik.zip"}

Gdy konczysz:
{"note":"krotkie podsumowanie toku pracy","final":"odpowiedz po polsku"}

Zasady:
- Nie probuj obchodzic sandboxa ani prosic o sciezki spoza root.
- Przed edycja czytaj plik, chyba ze go tworzysz.
- Komend shell uzywaj oszczednie; UI poprosi uzytkownika o zatwierdzenie.
- Zanim pobierzesz obraz z URL uzywajac download_file, upewnij sie ze adres istnieje. Uzywaj analyze_image aby sprawdzic pobrany obraz (tylko jpg/png/webp) i przeanalizowac, czy zawiera to, czego potrzebujesz.
- Eksplorujac web (fetch_url), upewnij sie, ze strona jest "legit" i bezpieczna, np. czytajac o niej informacje. Zawsze analizuj URL przed pobraniem czegokolwiek. Pobieranie plikow (download_file) wywola prosbe o zgode w UI.
- Jesli nie masz pewnosci co do jakiejs informacji albo podejrzewasz "fake news", ZAWSZE uzyj fetch_url, aby zweryfikowac fakty w innych stronach w sieci. Narzedzie extract_media uzywaj do wyciagania rzeczywistych linkow z poprawnej strony.
- NIE ZMYSLAJ LINKOW URL! Jesli dostaniesz 404, musisz wrocic do poprawnej domeny/artykulu i pobrac prawidlowe linki (np. za pomoca extract_media).
- Gdy tworzysz jeden lub więcej plików (np. SVG, PDF, skrypty), ZAWSZE najpierw upewnij się, że docelowy folder istnieje używając 'ls' lub od razu stwórz go używając 'mkdir' (względnie do obecnego katalogu, nie wychodź poza workspace). Dopiero potem zapisuj pliki.
- ZAWSZE generuj i zapisuj pliki pojedynczo. Jeśli masz 5 plików do utworzenia, użyj narzędzia 'write_file' 5 razy w osobnych krokach. NIGDY nie wyrzucaj zawartości wielu plików naraz w czacie jako gigantyczny tekst – to bez sensu i zapycha czat. Każdy plik to oddzielne zadanie i oddzielne wywołanie 'write_file'.
- Gdy narzedzie zwroci blad (np. brak narzedzia/undefined), wybierz inne z listy. Jesli write_file zwroci blad np. za dlugiego ciagu, zapisz plik od nowa partiami w trybie 'append'. Po zapisie kodu/skryptu zrob check (np. run_powershell), zeby zweryfikowac poprawnosc i dzialanie pliku.
- Gdy narzedzie zwroci inny blad, nie poddawaj sie od razu: przeczytaj powod, wybierz obejscie i sprobuj dalej. Typowe obejscia: mkdir dla brakujacego folderu, podzial na czesci (append), zapis do innego pliku w workspace.
- Note ma byc publiczna i krotka: plan, hipoteza albo decyzja, bez dlugiego ukrytego rozumowania.`;

const SKILL_CATALOG = [
  {
    id: "documents",
    name: "Documents",
    category: "Dokumenty",
    summary: "Raporty, notatki, briefy i dokumenty z lokalnych plikow.",
    instructions: "Do ogolnej pracy z dokumentami preferuj Markdown lub HTML jako zrodlo, zapisuj artefakty w workspace i opisz uzytkownikowi finalne pliki. Nie uzywaj uslug chmurowych.",
  },
  {
    id: "docx",
    name: "DOCX",
    category: "Dokumenty",
    summary: "Tworzenie, edycja i ekstrakcja tresci z plikow Word.",
    instructions: "Dla DOCX tworz lub modyfikuj pliki lokalnie. Jesli potrzebne biblioteki sa dostepne, uzyj lokalnego skryptu przez run_powershell po zgodzie; w przeciwnym razie przygotuj zrodlo HTML/Markdown i jasne kroki eksportu.",
  },
  {
    id: "pdf",
    name: "PDF",
    category: "Dokumenty",
    summary: "Czytanie, skladanie i eksport PDF bez zewnetrznych API.",
    instructions: "Dla PDF pracuj lokalnie: ekstrakcja tekstu, tworzenie HTML jako zrodla, scalanie lub eksport przez dostepne lokalne narzedzia. Nie wysylaj dokumentow poza maszyne.",
  },
  {
    id: "slides",
    name: "Slides",
    category: "Prezentacje",
    summary: "Konspekty, slajdy, speaker notes i eksport deckow.",
    instructions: "Dla prezentacji buduj strukture slajdow, notatki prelegenta i lokalne zrodla HTML/Markdown/PPTX. Preferuj pliki edytowalne i zachowuj zasoby obok decka.",
  },
  {
    id: "sheets",
    name: "Sheets / CSV",
    category: "Dane",
    summary: "Arkusze, CSV, tabele, kalkulacje i proste wykresy.",
    instructions: "Dla danych tabelarycznych uzywaj CSV/TSV/XLSX w workspace, zachowuj typy danych i podsumowuj transformacje. Formuly i wykresy opisuj tak, zeby byly odtwarzalne lokalnie.",
  },
  {
    id: "image-gen",
    name: "Image Gen",
    category: "Media",
    summary: "Prompty, assety i lokalne pipeline'y obrazow.",
    instructions: "Dla obrazow przygotowuj prompty, specyfikacje assetow, SVG/HTML/CSS albo uruchamiaj wylacznie lokalne generatory, jesli istnieja w workspace. Nie zakladaj dostepu do chmurowego image API.",
  },
  {
    id: "figma-local",
    name: "Figma Local",
    category: "Design",
    summary: "Praca na lokalnych eksportach z Figmy: SVG, PNG, JSON, CSS.",
    instructions: "Dla Figmy pracuj na wyeksportowanych lokalnie plikach. Nie lacz sie z Figma API. Mapuj style, warstwy i komponenty na kod lub dokumentacje w workspace.",
  },
  {
    id: "svg",
    name: "SVG / Icons",
    category: "Design",
    summary: "Czyste SVG, ikony, diagramy i optymalizacja wektorow.",
    instructions: "Dla SVG dbaj o viewBox, dostepnosc, skale i minimalny kod. Preferuj edytowalne pliki SVG zamiast bitmap, gdy obiekt jest ikoną, diagramem albo prostym assetem.",
  },
  {
    id: "file-export",
    name: "File Export",
    category: "Eksport",
    summary: "Eksport HTML, Markdown, ZIP, PDF-ready i paczek artefaktow.",
    instructions: "Dla eksportow tworz przewidywalne foldery wyjsciowe, manifest plikow i formaty latwe do sprawdzenia lokalnie. Nie nadpisuj niepowiazanych plikow.",
  },
  {
    id: "data-extract",
    name: "Data Extract",
    category: "Dane",
    summary: "Ekstrakcja tekstu, tabel, metadanych i porzadkowanie plikow.",
    instructions: "Dla ekstrakcji danych czytaj pliki lokalnie, zapisuj surowe i oczyszczone wyniki osobno, a transformacje opisuj w sposob audytowalny. Nie wysylaj danych do zewnetrznych serwisow.",
  },
  {
    id: "vision",
    name: "Vision (VLM Support)",
    category: "Zdolności Agenta",
    summary: "Włącza obsługę załączników obrazów na czacie oraz narzędzie analyze_image. Podczas instalacji pobiera lekki model VLM.",
    instructions: "Gdy używasz analyze_image lub wiesz, że użytkownik dostarczył obraz, polegasz na zewnętrznym asystencie wizji (Moondream2). Pamiętaj, aby opierać się na jego odczytach i przekazywać wnioski użytkownikowi wprost, ponieważ główny model działa bez obsługi obrazów.",
  },
];

let mainWindow;
let serverProcess = null;
let visionServerProcess = null;
let serverOwned = false;
let runningModelId = null;
let runInProgress = false;
let runAbortController = null;
let accessLevel = "sandbox"; // "sandbox" or "full"
let chatHistory = [];
let currentChatId = null;
const VISION_PORT = 11435;
let previousCpuInfo = os.cpus();

// Custom model settings (overrides per-reasoning defaults when set)
let customModelSettings = {
  temperature: null,     // null = use reasoning profile default
  maxTokens: null,
  maxSteps: null,        // null = use reasoning profile, 0 = unlimited
  topP: null,
  topK: null,
  repeatPenalty: null,
  contextTokens: null,   // override for model context window
  gpuLayers: null,       // override for GPU offload layers
};

function emit(type, payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("agent:event", {
      id: crypto.randomUUID(),
      type,
      at: new Date().toISOString(),
      ...payload,
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChildExit(child, timeoutMs = SERVER_SHUTDOWN_TIMEOUT_MS) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

function forceKillPid(pid) {
  const safePid = Number(pid);
  if (!Number.isInteger(safePid) || safePid <= 0 || safePid === process.pid) return false;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${safePid} /T /F`, { timeout: 5000, windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(safePid, "SIGKILL");
    }
    return true;
  } catch {
    return false;
  }
}

function getListeningPidsOnPort(port = DEFAULT_PORT) {
  const safePort = Number(port);
  if (!Number.isInteger(safePort) || safePort <= 0) return [];
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano -p tcp", { timeout: 5000, windowsHide: true }).toString();
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const localAddress = parts[1] || "";
        const state = parts[3] || "";
        const pid = Number(parts[4]);
        if (state.toUpperCase() === "LISTENING" && localAddress.includes(`:${safePort}`) && Number.isInteger(pid)) {
          pids.add(pid);
        }
      }
      return [...pids].filter((pid) => pid !== process.pid);
    }
    const out = execSync(`lsof -ti tcp:${safePort} -sTCP:LISTEN`, { timeout: 5000, windowsHide: true }).toString();
    return out.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

function createModelAbortGuard(parentSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MODEL_STREAM_IDLE_TIMEOUT_MS);
  };
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  reset();
  return {
    signal: controller.signal,
    reset,
    isTimedOut: () => timedOut,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
    },
  };
}

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function findBielikHome() {
  const starts = [
    process.env.BIELIK_HOME,
    process.cwd(),
    app.isPackaged ? path.dirname(process.execPath) : null,
    __dirname,
    path.resolve(__dirname, ".."),
    path.resolve(__dirname, "..", ".."),
  ].filter(Boolean);

  for (const start of starts) {
    let current = path.resolve(start);
    for (let i = 0; i < 10; i += 1) {
      const hasModelDir = pathExists(path.join(current, "models"));
      const hasRuntimeDir = pathExists(path.join(current, "runtime"));
      if (hasModelDir && hasRuntimeDir) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return path.resolve(__dirname, "..", "..");
}

const BIELIK_HOME = findBielikHome();
const bootSettings = readJsonFile(path.join(BIELIK_HOME, "config", "endocode-state.json"), {});
let workspaceRoot = path.resolve(bootSettings.workspaceRoot || path.join(BIELIK_HOME, "workspace"));
let cwd = workspaceRoot;

function readJsonFile(filePath, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadModelCatalog() {
  const fallback = {
    defaultModelId: "qwen25-coder-14b-q4km",
    models: [
      {
        id: "qwen25-coder-14b-q4km",
        displayName: "Qwen2.5-Coder 14B Q4_K_M",
        kind: "local-gguf",
        serverModel: "qwen2.5-coder-14b-instruct-q4_k_m",
        file: "models/qwen2.5-coder-14b-instruct-q4_k_m.gguf",
        contextTokens: 8192,
        gpuLayers: 99,
      },
    ],
  };
  return readJsonFile(path.join(BIELIK_HOME, "config", "models.json"), fallback);
}

function loadAppSettings() {
  return readJsonFile(path.join(BIELIK_HOME, "config", "endocode-state.json"), {});
}

function saveAppSettings() {
  writeJsonFile(path.join(BIELIK_HOME, "config", "endocode-state.json"), {
    selectedModelId,
    reasoningLevel: selectedReasoning,
    accessLevel,
    customModelSettings,
    maxMessages: MAX_MESSAGES,
    workspaceRoot,
  });
}

function getChatHistoryPath() {
  return path.join(BIELIK_HOME, "config", "chat-history.json");
}

function loadChatHistory() {
  try {
    const data = fs.readFileSync(getChatHistoryPath(), "utf8");
    chatHistory = JSON.parse(data);
  } catch {
    chatHistory = [];
  }
  return chatHistory;
}

function saveChatHistory() {
  writeJsonFile(getChatHistoryPath(), chatHistory);
}

function getSkillStorePath() {
  return path.join(BIELIK_HOME, "config", "skills.json");
}

function getSkillsRoot() {
  return path.join(BIELIK_HOME, "config", "skills");
}

function loadSkillStore() {
  const store = readJsonFile(getSkillStorePath(), { installed: [] });
  return { installed: Array.isArray(store.installed) ? store.installed : [] };
}

function saveSkillStore(store) {
  writeJsonFile(getSkillStorePath(), { installed: [...new Set(store.installed || [])] });
}

function getSkillById(skillId) {
  return SKILL_CATALOG.find((skill) => skill.id === skillId);
}

function getSkillsForUi() {
  const installed = new Set(loadSkillStore().installed);
  return SKILL_CATALOG.map((skill) => ({
    id: skill.id,
    name: skill.name,
    category: skill.category,
    summary: skill.summary,
    installed: installed.has(skill.id),
    localOnly: true,
    path: path.join(getSkillsRoot(), skill.id, "SKILL.md"),
  }));
}

function getActiveSkillsPrompt() {
  const installed = new Set(loadSkillStore().installed);
  return SKILL_CATALOG
    .map((skill) => {
      const state = installed.has(skill.id) ? "aktywny" : "dostepny";
      return `- ${skill.name} (${state}, local-only): ${skill.instructions}`;
    })
    .join("\n");
}

function createSkillMarkdown(skill) {
  return `# ${skill.name}

Category: ${skill.category}
Local only: yes

## Summary
${skill.summary}

## Agent Instructions
${skill.instructions}

## Local Runtime Rule
Use only local files, local model reasoning and approved local commands. Do not call cloud APIs unless the user explicitly adds such integration later.
`;
}

function refreshSystemPrompt() {
  if (Array.isArray(messages) && messages[0]?.role === "system") {
    messages[0] = { role: "system", content: createSystemPrompt() };
  }
}

async function installSkill(skillId) {
  const skill = getSkillById(skillId);
  if (!skill) throw new Error(`Nieznany skill: ${skillId}`);
  if (skillId === "vision") {
    await ensureVisionSupport();
  }
  const store = loadSkillStore();
  if (!store.installed.includes(skillId)) store.installed.push(skillId);
  saveSkillStore(store);
  const dir = path.join(getSkillsRoot(), skill.id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "SKILL.md"), createSkillMarkdown(skill), "utf8");
  refreshSystemPrompt();
  emit("status", { status: "skills-changed", detail: `Zainstalowano skill: ${skill.name}` });
  return getSkillsForUi();
}

async function uninstallSkill(skillId) {
  const skill = getSkillById(skillId);
  if (!skill) throw new Error(`Nieznany skill: ${skillId}`);
  const store = loadSkillStore();
  store.installed = store.installed.filter((id) => id !== skillId);
  saveSkillStore(store);
  await fsp.rm(path.join(getSkillsRoot(), skill.id), { recursive: true, force: true });
  if (skillId === "vision") {
    await fsp.rm(path.join(BIELIK_HOME, "models", "vision"), { recursive: true, force: true });
  }
  refreshSystemPrompt();
  emit("status", { status: "skills-changed", detail: `Odinstalowano skill: ${skill.name}` });
  return getSkillsForUi();
}

async function installRecommendedSkills() {
  const store = loadSkillStore();
  store.installed = [...new Set([...store.installed, ...SKILL_CATALOG.map((skill) => skill.id)])];
  saveSkillStore(store);
  await fsp.mkdir(getSkillsRoot(), { recursive: true });
  for (const skill of SKILL_CATALOG) {
    const dir = path.join(getSkillsRoot(), skill.id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "SKILL.md"), createSkillMarkdown(skill), "utf8");
  }
  refreshSystemPrompt();
  emit("status", { status: "skills-changed", detail: "Zainstalowano rekomendowany zestaw 10 lokalnych skilli." });
  return getSkillsForUi();
}

function getSystemInfo() {
  const cpus = os.cpus();
  let cpuPercent = 0;
  if (previousCpuInfo && previousCpuInfo.length === cpus.length) {
    let totalIdle = 0, totalTick = 0;
    for (let i = 0; i < cpus.length; i++) {
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

  let gpuPercent = -1;
  let vramUsedMB = -1;
  let vramTotalMB = -1;
  try {
    const out = execSync('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits', { timeout: 2000, windowsHide: true }).toString().trim();
    const parts = out.split(',').map(s => s.trim());
    gpuPercent = parseInt(parts[0], 10) || 0;
    vramUsedMB = parseInt(parts[1], 10) || 0;
    vramTotalMB = parseInt(parts[2], 10) || 0;
  } catch { /* no nvidia-smi */ }

  return {
    cpu: cpuPercent,
    gpu: gpuPercent,
    ramPercent,
    ramUsedGB: (usedMem / 1073741824).toFixed(1),
    ramTotalGB: (totalMem / 1073741824).toFixed(1),
    vramUsedMB,
    vramTotalMB,
    vramPercent: vramTotalMB > 0 ? Math.round((vramUsedMB / vramTotalMB) * 100) : -1,
  };
}

function getContextInfo() {
  return {
    messageCount: messages.length,
    maxMessages: MAX_MESSAGES,
    willCompactAt: MAX_MESSAGES,
    isNearCompaction: messages.length > MAX_MESSAGES - 4,
  };
}

const initialSettings = bootSettings;
let selectedModelId = initialSettings.selectedModelId || loadModelCatalog().defaultModelId || "qwen25-coder-14b-q4km";
let selectedReasoning = REASONING_LEVELS[initialSettings.reasoningLevel] ? initialSettings.reasoningLevel : "medium";

function getModelConfig() {
  const catalog = loadModelCatalog();
  return catalog.models.find((model) => model.id === selectedModelId) ||
    catalog.models.find((model) => model.id === catalog.defaultModelId) ||
    catalog.models[0];
}

function getReasoningProfile() {
  return REASONING_LEVELS[selectedReasoning] || REASONING_LEVELS.medium;
}

function createSystemPrompt() {
  const model = getModelConfig();
  const reasoning = getReasoningProfile();
  const skillsPrompt = getActiveSkillsPrompt();
  return `${BASE_SYSTEM_PROMPT}

Aktualny model: ${model.displayName || model.id}.
Intensywnosc pracy: ${reasoning.label}.
Instrukcja intensywnosci: ${reasoning.instruction}${skillsPrompt ? `

Dostepne lokalne skills:
${skillsPrompt}

Skills sa lokalnymi instrukcjami pracy, nie zewnetrznymi API. Jesli zadanie pasuje do skilla, uzyj go samodzielnie i zapisz artefakty w workspace.` : ""}`;
}

function createInitialMessages() {
  return [{ role: "system", content: createSystemPrompt() }];
}

function getModelsForUi() {
  const catalog = loadModelCatalog();
  return catalog.models.map((model) => {
    const modelPath = model.file ? path.resolve(BIELIK_HOME, model.file) : null;
    const fileStatus = getModelFileStatus(model);
    const available = model.kind === "local-gguf" ? fileStatus.available : Boolean(model.enabled);
    return {
      ...model,
      modelPath,
      fileStatus,
      available,
      selected: model.id === selectedModelId,
    };
  });
}

function getModelFileStatus(model) {
  if (model.kind !== "local-gguf" || !model.file) {
    return { available: Boolean(model.enabled), size: 0, expectedBytes: 0, progress: model.enabled ? 1 : 0 };
  }
  const modelPath = path.resolve(BIELIK_HOME, model.file);
  try {
    const size = fs.statSync(modelPath).size;
    const expectedBytes = Number(model.expectedBytes || 0);
    const progress = expectedBytes > 0 ? Math.min(size / expectedBytes, 1) : (size > 0 ? 1 : 0);
    const available = expectedBytes > 0 ? size >= expectedBytes : size > 0;
    return { available, size, expectedBytes, progress };
  } catch {
    return { available: false, size: 0, expectedBytes: Number(model.expectedBytes || 0), progress: 0 };
  }
}

function modelSizeForSort(model) {
  return Number(model.expectedBytes || model.fileStatus?.size || 0);
}

function getFallbackModelCandidates(failedModelIds) {
  const catalog = loadModelCatalog();
  const candidates = getModelsForUi()
    .filter((model) => model.kind === "local-gguf" && model.available)
    .filter((model) => model.id !== selectedModelId && !failedModelIds.has(model.id))
    .sort((a, b) => modelSizeForSort(a) - modelSizeForSort(b));
  const defaultCandidate = candidates.find((model) => model.id === catalog.defaultModelId);
  if (!defaultCandidate) return candidates;
  return [defaultCandidate, ...candidates.filter((model) => model.id !== defaultCandidate.id)];
}

async function switchToFallbackModel(reason, failedModelIds) {
  failedModelIds.add(selectedModelId);
  const candidates = getFallbackModelCandidates(failedModelIds);
  for (const fallback of candidates) {
    try {
      selectedModelId = fallback.id;
      saveAppSettings();
      if (messages.length) messages[0] = { role: "system", content: createSystemPrompt() };
      emit("status", {
        status: "model-fallback",
        detail: `Przelaczam na ${fallback.displayName}: ${String(reason || "blad modelu").slice(0, 140)}`,
      });
      await stopOwnedServer({ force: true });
      await ensureServer(DEFAULT_PORT);
      return fallback;
    } catch (error) {
      failedModelIds.add(fallback.id);
      emit("status", {
        status: "model-fallback-failed",
        detail: `${fallback.displayName}: ${error.message || String(error)}`,
      });
    }
  }
  return null;
}

function normalizeInsideRoot(rawPath = ".") {
  const base = path.isAbsolute(String(rawPath)) ? String(rawPath) : path.join(cwd, String(rawPath));
  const resolved = path.resolve(base);
  if (accessLevel === "full") return resolved;
  const rel = path.relative(workspaceRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Sciezka wychodzi poza sandbox: ${rawPath}`);
  }
  return resolved;
}

function relativeToRoot(p) {
  const rel = path.relative(workspaceRoot, p);
  return rel.length ? rel : ".";
}

function getFallbackWorkspaceRoot() {
  return os.homedir() || path.join(BIELIK_HOME, "workspace");
}

async function applyWorkspaceRoot(root, options = {}) {
  const create = Boolean(options.create);
  const requestedRoot = root ? path.resolve(String(root)) : "";
  let target = requestedRoot || getFallbackWorkspaceRoot();
  let fallbackUsed = false;
  let message = "";

  try {
    if (create) {
      await fsp.mkdir(target, { recursive: true });
    }
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) throw new Error("To nie jest folder.");
  } catch {
    fallbackUsed = true;
    target = path.resolve(getFallbackWorkspaceRoot());
    await fsp.mkdir(target, { recursive: true });
    message = "wybierz folder na którym pracujemy";
  }

  workspaceRoot = target;
  cwd = workspaceRoot;
  if (!options.skipSave) saveAppSettings();
  return {
    ...getState(),
    workspaceFallback: {
      used: fallbackUsed,
      requestedRoot,
      fallbackRoot: target,
      message,
    },
  };
}

async function ensureWorkspaceRoot(root) {
  return applyWorkspaceRoot(root, { create: true });
}

async function restoreWorkspaceRoot(root) {
  return applyWorkspaceRoot(root, { create: false });
}

async function validateCurrentWorkspaceRoot() {
  try {
    const stat = await fsp.stat(workspaceRoot);
    if (stat.isDirectory()) return null;
  } catch {
    // fallback below
  }
  const state = await restoreWorkspaceRoot(workspaceRoot);
  if (state.workspaceFallback?.used) emit("workspace-missing", state.workspaceFallback);
  return state;
}

function getRuntimeServerExe() {
  const runtimeDir = path.join(BIELIK_HOME, "runtime");
  const stack = [runtimeDir];
  while (stack.length) {
    const dir = stack.pop();
    if (!pathExists(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (entry.isFile() && entry.name.toLowerCase() === "llama-server.exe") return full;
    }
  }
  return null;
}

function getModelPath() {
  const config = getModelConfig();
  if (!config?.file) return null;
  return path.resolve(BIELIK_HOME, config.file);
}

function appendServerOptionArgs(serverArgs, config) {
  const numberOptions = [
    ["threads", "--threads"],
    ["threadsBatch", "--threads-batch"],
    ["batchSize", "--batch-size"],
    ["ubatchSize", "--ubatch-size"],
    ["parallel", "--parallel"],
  ];
  for (const [key, flag] of numberOptions) {
    if (config[key] !== undefined && config[key] !== null) {
      serverArgs.push(flag, String(config[key]));
    }
  }
  if (config.flashAttention !== undefined) serverArgs.push("--flash-attn", String(config.flashAttention));
  if (config.cacheTypeK) serverArgs.push("--cache-type-k", String(config.cacheTypeK));
  if (config.cacheTypeV) serverArgs.push("--cache-type-v", String(config.cacheTypeV));
  if (Array.isArray(config.extraServerArgs)) {
    for (const arg of config.extraServerArgs) serverArgs.push(String(arg));
  }
}

async function isServerReady(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function getServerModelId(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function launchServerProcess(config, modelPath, port, contextTokens, gpuLayers) {
  await fsp.mkdir(path.join(BIELIK_HOME, "logs"), { recursive: true });
  const outLog = fs.openSync(path.join(BIELIK_HOME, "logs", "local-codex-server.out.log"), "a");
  const errLog = fs.openSync(path.join(BIELIK_HOME, "logs", "local-codex-server.err.log"), "a");
  const serverExe = getRuntimeServerExe();
  if (!serverExe) throw new Error("Nie znaleziono runtime/llama-server.exe.");

  emit("status", { status: "server-starting", detail: `Uruchamiam: ${config.displayName} (ctx ${contextTokens}, GPU layers ${gpuLayers}).` });
  const serverArgs = [
    "-m", modelPath,
    "-c", String(contextTokens),
    "-ngl", String(gpuLayers),
    "--host", "127.0.0.1",
    "--port", String(port),
    "--jinja",
  ];
  if (config.reasoning) {
    serverArgs.push("--reasoning", String(config.reasoning));
  }
  if (config.reasoningBudget !== undefined) {
    serverArgs.push("--reasoning-budget", String(config.reasoningBudget));
  }
  appendServerOptionArgs(serverArgs, config);

  let child;
  try {
    child = spawn(serverExe, serverArgs, {
      cwd: path.dirname(serverExe),
      stdio: ["ignore", outLog, errLog],
      windowsHide: true,
    });
  } finally {
    try { fs.closeSync(outLog); } catch { /* ignore */ }
    try { fs.closeSync(errLog); } catch { /* ignore */ }
  }
  serverProcess = child;
  serverOwned = true;
  runningModelId = selectedModelId;

  child.once("exit", (code) => {
    emit("status", { status: "server-stopped", detail: `llama-server zakonczyl prace: ${code}` });
    if (serverProcess === child) {
      serverProcess = null;
      serverOwned = false;
      runningModelId = null;
    }
  });

  for (let i = 0; i < 180; i += 1) {
    if (serverProcess?.exitCode !== null) throw new Error("llama-server zakonczyl prace przed startem API.");
    if (await isServerReady(port)) {
      emit("status", { status: "server-ready", detail: `${config.displayName} gotowy na http://127.0.0.1:${port}` });
      return;
    }
    await sleep(1000);
  }
  throw new Error("Serwer nie odpowiedzial w ciagu 180 sekund.");
}

async function ensureServer(port = DEFAULT_PORT) {
  const config = getModelConfig();
  if (!config || config.kind !== "local-gguf") {
    throw new Error("Ten model nie jest lokalnym GGUF. Claude Opus 4.5 wymaga API, nie lokalnego runtime.");
  }

  if (await isServerReady(port)) {
    const liveModel = await getServerModelId(port);
    const expectedFile = path.basename(getModelPath());
    const matchesCurrent = runningModelId === selectedModelId ||
      liveModel === config.serverModel ||
      (liveModel && liveModel.includes(expectedFile));
    if (matchesCurrent) {
      runningModelId = selectedModelId;
      emit("status", { status: "server-ready", detail: `Uzywam aktywnego serwera: ${config.displayName}.` });
      return;
    }
    if (serverOwned) {
      await stopOwnedServer();
    } else {
      throw new Error(`Port ${port} zajmuje inny model (${liveModel || "nieznany"}). Zamknij ten serwer albo uruchom ponownie aplikacje.`);
    }
  }

  const modelPath = getModelPath();
  const fileStatus = getModelFileStatus(config);
  if (!fileStatus.available) {
    const percent = Math.round((fileStatus.progress || 0) * 100);
    throw new Error(`Model nie jest jeszcze gotowy: ${config.displayName} (${percent}%).`);
  }

  const contextTokens = customModelSettings.contextTokens ?? config.contextTokens ?? 8192;
  const configuredGpuLayers = customModelSettings.gpuLayers ?? config.gpuLayers ?? 99;
  const gpuLayerAttempts = customModelSettings.gpuLayers != null
    ? [configuredGpuLayers]
    : [...new Set([configuredGpuLayers, ...(config.gpuLayerFallbacks || [])])];
  let lastError = null;
  for (let i = 0; i < gpuLayerAttempts.length; i += 1) {
    try {
      await launchServerProcess(config, modelPath, port, contextTokens, gpuLayerAttempts[i]);
      return;
    } catch (error) {
      lastError = error;
      await stopOwnedServer({ force: true });
      if (i < gpuLayerAttempts.length - 1) {
        emit("status", {
          status: "server-starting",
          detail: `Start nie wyszedl (${error.message || String(error)}). Probuje GPU layers ${gpuLayerAttempts[i + 1]}.`,
        });
      }
    }
  }
  throw lastError || new Error("Nie udalo sie uruchomic modelu.");
}

async function stopOwnedServer(options = {}) {
  const force = Boolean(options.force);
  if (serverProcess && serverOwned) {
    const child = serverProcess;
    const pid = child.pid;
    emit("status", { status: "server-stopping", detail: "Zatrzymuje lokalny serwer." });
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const exited = await waitForChildExit(child);
    if (!exited && force && pid) {
      emit("status", { status: "server-killing", detail: `Wymuszam zamkniecie procesu modelu PID ${pid}.` });
      forceKillPid(pid);
      await waitForChildExit(child, 3000);
    }
    serverProcess = null;
    serverOwned = false;
    runningModelId = null;
    for (let i = 0; i < 30; i += 1) {
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    if (child.exitCode === null) {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }
  }

  if (visionServerProcess) {
    try { process.kill(visionServerProcess.pid, "SIGKILL"); } catch {}
    visionServerProcess = null;
  }
  if (force && options.killPort) {
    const pids = getListeningPidsOnPort(DEFAULT_PORT);
    for (const pid of pids) forceKillPid(pid);
    for (let i = 0; i < 30; i += 1) {
      if (!(await isServerReady(DEFAULT_PORT))) return;
      await sleep(200);
    }
  }
}

async function killModelServerResources() {
  const hadRun = Boolean(runAbortController);
  if (runAbortController) runAbortController.abort();
  const ownedPid = serverProcess?.pid || null;
  await stopOwnedServer({ force: true });

  const pids = getListeningPidsOnPort(DEFAULT_PORT);
  const killedPids = [];
  for (const pid of pids) {
    if (forceKillPid(pid)) killedPids.push(pid);
  }
  for (let i = 0; i < 30; i += 1) {
    if (!(await isServerReady(DEFAULT_PORT))) break;
    await sleep(200);
  }

  const alive = await isServerReady(DEFAULT_PORT);
  serverProcess = null;
  serverOwned = false;
  runningModelId = null;
  const detail = alive
    ? `Kill switch wykonany, ale port ${DEFAULT_PORT} nadal odpowiada.`
    : `Kill switch zakonczony. Zwolniono port ${DEFAULT_PORT}.`;
  emit("status", { status: "server-killed", detail });
  return { aborted: hadRun, ownedPid, killedPids, port: DEFAULT_PORT, alive };
}

async function callModel(messages, abortSignal) {
  if (abortSignal?.aborted) throw new Error("Przerwano przez uzytkownika.");
  const abortGuard = createModelAbortGuard(abortSignal);
  const reasoning = getReasoningProfile();
  const temp = customModelSettings.temperature ?? reasoning.temperature;
  const maxTok = customModelSettings.maxTokens ?? reasoning.maxTokens;
  const body = {
    model: getModelConfig().serverModel,
    messages,
    temperature: temp,
    max_tokens: maxTok,
    stream: true,
  };
  if (customModelSettings.topP != null) body.top_p = customModelSettings.topP;
  if (customModelSettings.topK != null) body.top_k = customModelSettings.topK;
  if (customModelSettings.repeatPenalty != null) body.repeat_penalty = customModelSettings.repeatPenalty;

  try {
    const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortGuard.signal,
    });
    abortGuard.reset();
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Model API ${res.status}: ${text.slice(0, 600)}`);
    }

    // Stream response for live display
    let fullContent = "";
    let thinkingContent = "";
    let inThinking = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      if (abortSignal?.aborted) throw new Error("Przerwano przez uzytkownika.");
      const { done, value } = await reader.read();
      abortGuard.reset();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const stripped = line.trim();
        if (!stripped || stripped === "data: [DONE]") continue;
        if (!stripped.startsWith("data: ")) continue;
        try {
          const chunk = JSON.parse(stripped.slice(6));
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          // Handle reasoning_content (thinking tokens)
          if (delta.reasoning_content) {
            thinkingContent += delta.reasoning_content;
            if (!inThinking) {
              inThinking = true;
              emit("thinking-start", {});
            }
            emit("thinking-delta", { text: delta.reasoning_content, full: thinkingContent });
          }

          // Handle regular content
          if (delta.content) {
            if (inThinking) {
              inThinking = false;
              emit("thinking-end", { full: thinkingContent });
            }
            fullContent += delta.content;
            emit("content-delta", { text: delta.content, full: fullContent });
          }
        } catch {
          // malformed SSE chunk, skip
        }
      }
    }

    if (inThinking) {
      emit("thinking-end", { full: thinkingContent });
    }

    return fullContent;
  } catch (error) {
    if (abortSignal?.aborted) throw new Error("Przerwano przez uzytkownika.");
    if (abortGuard.isTimedOut()) {
      throw new Error(`Model nie wyslal danych przez ${Math.round(MODEL_STREAM_IDLE_TIMEOUT_MS / 1000)} sekund.`);
    }
    throw error;
  } finally {
    abortGuard.cleanup();
  }
}

function isTransientModelError(error) {
  const message = String(error?.message || error);
  if (/image input is not supported|mmproj/i.test(message)) return false;
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket|terminated|timeout|nie wyslal danych|Model API 5\d\d/i.test(message);
}

async function callModelWithRecovery(messages, abortSignal, failedModelIds) {
  let lastError = null;
  for (let attempt = 0; attempt <= MODEL_CALL_RETRY_LIMIT; attempt += 1) {
    try {
      return await callModel(messages, abortSignal);
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      lastError = error;
      if (attempt >= MODEL_CALL_RETRY_LIMIT || !isTransientModelError(error)) break;
      emit("status", {
        status: "model-call-retry",
        detail: `Problem z runtime modelu. Restart i ponowna proba (${attempt + 1}/${MODEL_CALL_RETRY_LIMIT}).`,
      });
      await stopOwnedServer({ force: true });
      await ensureServer(DEFAULT_PORT);
    }
  }
  if (lastError && isTransientModelError(lastError) && failedModelIds) {
    const fallback = await switchToFallbackModel(lastError.message || String(lastError), failedModelIds);
    if (fallback) return callModelWithRecovery(messages, abortSignal, failedModelIds);
  }
  throw lastError;
}

function parseJsonAction(raw) {
  let text = String(raw).trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }
  try {
    return JSON.parse(text);
  } catch {
    const firstObject = extractFirstJsonObject(text);
    if (firstObject) return JSON.parse(firstObject);
    throw new Error(`Model nie zwrocil JSON: ${text.slice(0, 300)}`);
  }
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function makeJsonRepairPrompt(error, raw) {
  return `Poprzednia odpowiedz nie byla poprawnym pojedynczym JSON-em i zostala odrzucona.
Blad parsera: ${String(error?.message || error).slice(0, 500)}

Odpowiedz teraz wylacznie jednym poprawnym JSON-em zgodnym z kontraktem systemowym.
Nie uzywaj Markdown, komentarzy ani tekstu przed/po JSON.
Jesli nie wiesz co zrobic dalej, zwroc final:
{"note":"odzysk po bledzie JSON","final":"Nie udalo sie bezpiecznie kontynuowac."}

Odrzucona odpowiedz:
${String(raw || "").slice(0, 1600)}`;
}

async function getNextActionWithRepair(abortSignal, failedModelIds) {
  let lastError = null;
  while (true) {
    for (let attempt = 0; attempt <= MODEL_JSON_RETRY_LIMIT; attempt += 1) {
      if (attempt > 0) {
        emit("status", {
          status: "model-json-retry",
          detail: `Naprawiam odpowiedz JSON (${attempt}/${MODEL_JSON_RETRY_LIMIT}).`,
        });
      }
      const raw = await callModelWithRecovery(messages, abortSignal, failedModelIds);
      emit("model-raw", { raw });
      try {
        return parseJsonAction(raw);
      } catch (error) {
        lastError = error;
        emit("parse-error", {
          error: error.message || String(error),
          attempt: attempt + 1,
          maxAttempts: MODEL_JSON_RETRY_LIMIT + 1,
          raw: textPreview(raw, 1200),
        });
        if (attempt >= MODEL_JSON_RETRY_LIMIT) break;
        messages.push({
          role: "assistant",
          content: JSON.stringify({
            note: "Poprzednia odpowiedz modelu byla niepoprawnym JSON-em i zostala odrzucona.",
          }),
        });
        messages.push({ role: "user", content: makeJsonRepairPrompt(error, raw) });
      }
    }
    const fallback = failedModelIds
      ? await switchToFallbackModel(`niepoprawny JSON: ${lastError?.message || "blad parsera"}`, failedModelIds)
      : null;
    if (!fallback) break;
    messages.push({
      role: "user",
      content: `Aktualny model zostal przelaczony na ${fallback.displayName}. Kontynuuj od ostatniego bezpiecznego kroku i zwroc poprawny JSON.`,
    });
  }
  throw new Error(`Model zwrocil niepoprawny JSON po kilku probach: ${lastError?.message || "nieznany blad"}`);
}

function textPreview(value, limit = 26000) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated]` : text;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function simpleMarkdownToHtml(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const html = [];
  let inList = false;
  let inCode = false;
  let codeLines = [];
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${htmlEscape(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      html.push("<div class=\"spacer\"></div>");
    } else if (trimmed.startsWith("### ")) {
      closeList();
      html.push(`<h3>${htmlEscape(trimmed.slice(4))}</h3>`);
    } else if (trimmed.startsWith("## ")) {
      closeList();
      html.push(`<h2>${htmlEscape(trimmed.slice(3))}</h2>`);
    } else if (trimmed.startsWith("# ")) {
      closeList();
      html.push(`<h1>${htmlEscape(trimmed.slice(2))}</h1>`);
    } else if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${htmlEscape(trimmed.replace(/^[-*]\s+/, ""))}</li>`);
    } else {
      closeList();
      html.push(`<p>${htmlEscape(trimmed)}</p>`);
    }
  }
  closeList();
  if (inCode) html.push(`<pre><code>${htmlEscape(codeLines.join("\n"))}</code></pre>`);
  return html.join("\n");
}

async function createPdfFile(args) {
  const target = normalizeInsideRoot(args.path || "output.pdf");
  const pdfPath = target.toLowerCase().endsWith(".pdf") ? target : `${target}.pdf`;
  await fsp.mkdir(path.dirname(pdfPath), { recursive: true });
  await fsp.mkdir(path.join(workspaceRoot, ".tmp"), { recursive: true });

  const title = String(args.title || path.basename(pdfPath, ".pdf"));
  const contentHtml = args.html
    ? String(args.html)
    : simpleMarkdownToHtml(args.markdown ?? args.content ?? "");
  const pageHtml = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>${htmlEscape(title)}</title>
<style>
  body { font-family: "Segoe UI", Arial, sans-serif; color: #111827; margin: 42px; font-size: 12.5px; line-height: 1.55; }
  h1 { font-size: 25px; margin: 0 0 18px; color: #0f172a; }
  h2 { font-size: 18px; margin: 22px 0 10px; color: #0f172a; }
  h3 { font-size: 14px; margin: 16px 0 8px; color: #1f2937; }
  p { margin: 0 0 9px; }
  ul { margin: 0 0 10px 20px; padding: 0; }
  li { margin: 0 0 5px; }
  pre { background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 6px; padding: 10px; white-space: pre-wrap; }
  .spacer { height: 8px; }
</style>
</head>
<body>${contentHtml}</body>
</html>`;

  const tempHtml = path.join(workspaceRoot, ".tmp", `pdf-${crypto.randomUUID()}.html`);
  await fsp.writeFile(tempHtml, pageHtml, "utf8");
  const pdfWindow = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await pdfWindow.loadFile(tempHtml);
    const data = await pdfWindow.webContents.printToPDF({
      pageSize: args.pageSize || "A4",
      printBackground: true,
      margins: { marginType: "default" },
    });
    await fsp.writeFile(pdfPath, data);
  } finally {
    try { pdfWindow.destroy(); } catch { /* ignore */ }
    try { await fsp.rm(tempHtml, { force: true }); } catch { /* ignore */ }
  }
  return { path: relativeToRoot(pdfPath), bytes: fs.statSync(pdfPath).size, title };
}

async function readTextIfExists(file) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function makeLineDiff(before, after) {
  if (before === after) return [];
  const a = String(before ?? "").split(/\r?\n/);
  const b = String(after ?? "").split(/\r?\n/);
  const rows = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (a[i] === b[i]) {
      if (rows.length < 240) rows.push({ type: "same", text: a[i] ?? "" });
    } else {
      if (a[i] !== undefined) rows.push({ type: "remove", text: a[i] });
      if (b[i] !== undefined) rows.push({ type: "add", text: b[i] });
    }
    if (rows.length >= 260) {
      rows.push({ type: "meta", text: "...diff skrocony..." });
      break;
    }
  }
  return rows;
}

function getToolRecoveryHint(error, action) {
  const message = String(error?.message || error);
  const tool = action?.tool || "narzedzie";
  if (/poza sandbox|Sciezka wychodzi/i.test(message)) {
    return "Uzyj sciezki wzglednej w aktualnym workspace albo utworz podfolder w workspace i zapisz tam wynik. Nie probuj zapisywac poza sandboxiem.";
  }
  if (/ENOENT|nie znaleziono|Nie znaleziono/i.test(message)) {
    return "Sprawdz ls/pwd, utworz brakujacy folder przez mkdir albo przeczytaj plik o poprawnej nazwie zanim ponowisz operacje.";
  }
  if (/EACCES|EPERM|access denied|odmowa/i.test(message)) {
    return "Brak uprawnien. Zapisz alternatywny plik w workspace, np. output/ lub exports/, i poinformuj uzytkownika o obejściu.";
  }
  if (/does not support vision|image_url|multimodal/i.test(message)) {
    return "Model nie obsługuje analizy obrazów (brak modułu Vision). Przerwij próbę analyze_image i w 'final' przeproś użytkownika, informując, że Twój obecny model nie ma zdolności widzenia.";
  }
  if (/(403|404)/.test(message) && (tool === "fetch_url" || tool === "download_file")) {
    return "Błąd 404/403. Przestań zgadywać linki URL w ciemno! Wróć na stronę domową lub artykuł i użyj narzędzia extract_media lub fetch_url, aby odczytać PRAWDZIWE adresy z kodu HTML.";
  }
  if (tool === "write_file" || tool === "replace_text") {
    return "Jesli zapis nie jest mozliwy (np. tekst za dlugi), zacznij od nowa zapisujac partiami przez mode 'append' w konkretnych miejscach. Jesli to nowy skrypt, sprawdz potem przez run_powershell czy sie wykonuje/otwiera poprawnie. W ostatecznosci utworz plik obok w exports/.";
  }
  if (/Nieznane narzedzie|undefined/i.test(message)) {
    return "Uzyto zlego lub nieistniejacego (undefined) narzedzia. Zmien na poprawne narzedzie z listy 'Dostepne narzedzia'.";
  }
  if (tool === "create_pdf") {
    return "Jesli PDF nie powstal, zapisz zrodlo HTML/Markdown w workspace i sprobuj ponownie create_pdf z prostszym HTML.";
  }
  if (/zablokowane|odrzucil|blocked/i.test(message)) {
    return "Komenda lub akcja zostala zablokowana. Uzyj bezpieczniejszego lokalnego narzedzia, plikow w workspace albo popros o zgode tylko na minimalna potrzebna komende.";
  }
  return "Przeanalizuj blad, wybierz najbezpieczniejsze obejscie i kontynuuj. Nie koncz zadania, jesli istnieje lokalna alternatywa.";
}

async function askApproval(request) {
  return new Promise((resolve) => {
    const approvalId = crypto.randomUUID();
    ipcMain.once(`approval:${approvalId}`, (_event, approved) => resolve(Boolean(approved)));
    emit("approval-request", { approvalId, request });
  });
}

const blockedShellPatterns = [
  { re: /(^|[^a-z0-9_])(invoke-webrequest|curl|wget|bitsadmin|ssh|scp|sftp)\b/i, reason: "komendy sieciowe/pobieranie sa zablokowane" },
  { re: /(^|[^a-z0-9_])(start-process|powershell|pwsh|cmd|wsl|docker)\b/i, reason: "launchery procesow sa zablokowane" },
  { re: /[a-z]:[\\/]/i, reason: "sciezki absolutne Windows sa zablokowane" },
  { re: /(^|\s)\\\\|\s\/\//, reason: "sciezki sieciowe sa zablokowane" },
  { re: /(^|[\s"'])~([\\/]|[\s"']|$)/, reason: "skrot katalogu home jest zablokowany" },
  { re: /(^|[\s"'])\.\.([\\/]|[\s"']|$)/, reason: "wyjscie przez .. jest zablokowane" },
];

async function runPowerShell(command, timeoutSeconds) {
  for (const item of blockedShellPatterns) {
    if (item.re.test(command)) throw new Error(item.reason);
  }
  const approved = await askApproval({
    title: "Model prosi o uruchomienie komendy",
    cwd: relativeToRoot(cwd),
    command,
  });
  if (!approved) throw new Error("Uzytkownik odrzucil komende.");

  return new Promise((resolve) => {
    const timeout = Math.max(1, Math.min(Number(timeoutSeconds) || 60, 300)) * 1000;
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: path.join(workspaceRoot, ".tmp"),
        TMP: path.join(workspaceRoot, ".tmp"),
        BIELIK_SANDBOX_ROOT: workspaceRoot,
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      stderr += "\n[timeout]";
    }, timeout);
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        cwd: relativeToRoot(cwd),
        exitCode: code,
        stdout: textPreview(stdout),
        stderr: textPreview(stderr),
      });
    });
  });
}

async function executeTool(action) {
  const tool = action.tool;
  const args = action.args || {};
  emit("tool-start", { note: action.note || "", tool, args });

  let result;
  if (tool === "pwd") {
    result = { root: workspaceRoot, cwd: relativeToRoot(cwd) };
  } else if (tool === "cd") {
    const target = normalizeInsideRoot(args.path || ".");
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) throw new Error(`To nie jest folder: ${args.path}`);
    cwd = target;
    result = { cwd: relativeToRoot(cwd) };
  } else if (tool === "ls") {
    const target = normalizeInsideRoot(args.path || ".");
    const stat = await fsp.stat(target);
    if (stat.isFile()) {
      result = { path: relativeToRoot(target), type: "file", size: stat.size };
    } else {
      const maxEntries = Math.max(1, Math.min(Number(args.maxEntries) || 100, 500));
      const entries = await fsp.readdir(target, { withFileTypes: true });
      result = {
        path: relativeToRoot(target),
        entries: entries
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .slice(0, maxEntries)
          .map((entry) => {
            const full = path.join(target, entry.name);
            const size = entry.isFile() ? fs.statSync(full).size : null;
            return { name: entry.name, path: relativeToRoot(full), type: entry.isDirectory() ? "dir" : "file", size };
          }),
      };
    }
  } else if (tool === "read_file") {
    const target = normalizeInsideRoot(args.path);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error(`To nie jest plik: ${args.path}`);
    const maxBytes = Math.max(1, Math.min(Number(args.maxBytes) || 30000, MAX_FILE_BYTES));
    const buffer = await fsp.readFile(target);
    result = {
      path: relativeToRoot(target),
      bytes: buffer.length,
      truncated: buffer.length > maxBytes,
      content: buffer.subarray(0, maxBytes).toString("utf8"),
    };
  } else if (tool === "mkdir") {
    const target = normalizeInsideRoot(args.path);
    await fsp.mkdir(target, { recursive: true });
    result = { path: relativeToRoot(target) };
  } else if (tool === "write_file") {
    const target = normalizeInsideRoot(args.path);
    const before = await readTextIfExists(target);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if ((args.mode || "overwrite") === "append") {
      await fsp.appendFile(target, String(args.content ?? ""), "utf8");
    } else {
      await fsp.writeFile(target, String(args.content ?? ""), "utf8");
    }
    const after = await readTextIfExists(target);
    result = { path: relativeToRoot(target), bytes: fs.statSync(target).size, mode: args.mode || "overwrite" };
    emit("file-change", {
      path: relativeToRoot(target),
      action: "write_file",
      diff: makeLineDiff(before ?? "", after ?? ""),
      before: textPreview(before ?? ""),
      after: textPreview(after ?? ""),
    });
  } else if (tool === "replace_text") {
    const target = normalizeInsideRoot(args.path);
    const before = await fsp.readFile(target, "utf8");
    const oldText = String(args.old ?? "");
    const newText = String(args.new ?? "");
    if (!oldText) throw new Error("old nie moze byc puste.");
    const occurrences = before.split(oldText).length - 1;
    if (!occurrences) throw new Error("Nie znaleziono tekstu do zamiany.");
    const count = Number.isInteger(Number(args.count)) ? Number(args.count) : 1;
    let after;
    if (count < 0) {
      after = before.split(oldText).join(newText);
    } else {
      let remaining = count;
      after = before.replaceAll(oldText, () => {
        if (remaining <= 0) return oldText;
        remaining -= 1;
        return newText;
      });
    }
    await fsp.writeFile(target, after, "utf8");
    result = { path: relativeToRoot(target), replaced: count < 0 ? occurrences : Math.min(occurrences, count) };
    emit("file-change", {
      path: relativeToRoot(target),
      action: "replace_text",
      diff: makeLineDiff(before, after),
      before: textPreview(before),
      after: textPreview(after),
    });
  } else if (tool === "create_pdf") {
    result = await createPdfFile(args);
    emit("file-change", {
      path: result.path,
      action: "create_pdf",
      diff: [],
      before: "",
      after: `PDF: ${result.title} (${result.bytes} bytes)`,
    });
  } else if (tool === "run_powershell") {
    result = await runPowerShell(String(args.command ?? ""), args.timeout);
  } else if (tool === "fetch_url") {
    const res = await fetch(args.url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    const text = await res.text();
    const cleanText = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    result = { url: args.url, status: res.status, content: cleanText.slice(0, 25000) + (cleanText.length > 25000 ? "... (skrocono)" : "") };
  } else if (tool === "extract_media") {
    const res = await fetch(args.url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    const text = await res.text();
    const imgMatches = [...text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)];
    const urls = imgMatches.map(m => {
      try { return new URL(m[1], args.url).href; } catch { return m[1]; }
    }).filter(Boolean);
    result = { url: args.url, media_count: urls.length, media_urls: [...new Set(urls)].slice(0, 100) };
  } else if (tool === "download_file") {
    const target = normalizeInsideRoot(args.path);
    const approved = await askApproval({
      title: "Model prosi o pobranie pliku z sieci",
      cwd: relativeToRoot(cwd),
      command: `Pobierz URL: ${args.url}\nDo pliku: ${relativeToRoot(target)}`,
    });
    if (!approved) throw new Error("Uzytkownik odrzucil pobieranie pliku.");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const res = await fetch(args.url, { redirect: "follow", signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target));
    result = { path: relativeToRoot(target), bytes: fs.statSync(target).size };
    emit("file-change", {
      path: relativeToRoot(target),
      action: "download_file",
      diff: [],
      before: "",
      after: `Pobrano ${result.bytes} bajtow z ${args.url}`,
    });
  } else if (tool === "analyze_image") {
    const store = loadSkillStore();
    if (!store.installed.includes("vision")) {
      throw new Error("Narzędzie analyze_image wymaga zainstalowanego skilla 'Vision (VLM Support)'. Zainstaluj go w panelu Skills.");
    }
    const target = normalizeInsideRoot(args.path);
    emit("activity", { detail: `Pomocniczy model VLM analizuje obraz: ${args.path}` });
    const description = await runVisionSupport(target, "Describe this image in detail.");
    result = { description, status: `Analiza obrazu zakończona pomyślnie. Tekstowy opis załączono w pole description.` };
  } else {
    throw new Error(`Nieznane narzedzie: ${tool}`);
  }

  emit("tool-result", { tool, ok: true, result });
  return result;
}

async function downloadFileWithProgress(url, targetPath, label) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFileWithProgress(res.headers.location, targetPath, label).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`Błąd HTTP ${res.statusCode} pobierania ${label}`));
      
      const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
      let downloadedBytes = 0;
      let lastReportTime = 0;
      const file = fs.createWriteStream(targetPath);
      
      res.on("data", (chunk) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastReportTime > 500 && totalBytes > 0) {
          const pct = Math.round((downloadedBytes / totalBytes) * 100);
          emit("status", { status: "downloading", detail: `${label}: ${pct}%` });
          lastReportTime = now;
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      fs.unlink(targetPath, () => {});
      reject(err);
    });
  });
}

async function ensureVisionSupport() {
  const visionDir = path.join(BIELIK_HOME, "models", "vision");
  await fsp.mkdir(visionDir, { recursive: true });
  
  const textModelUrl = "https://huggingface.co/moondream/moondream2-gguf/resolve/main/moondream2-text-model-f16.gguf";
  const mmprojUrl = "https://huggingface.co/moondream/moondream2-gguf/resolve/main/moondream2-mmproj-f16.gguf";
  const textModelPath = path.join(visionDir, "moondream2-text-model-f16.gguf");
  const mmprojPath = path.join(visionDir, "moondream2-mmproj-f16.gguf");
  
  if (!fs.existsSync(textModelPath)) {
    emit("activity", { detail: `Pobieram Moondream2 Text Model (1GB, to potrwa chwilę)...` });
    await downloadFileWithProgress(textModelUrl, textModelPath, "Pobieranie Moondream2");
  }
  if (!fs.existsSync(mmprojPath)) {
    emit("activity", { detail: `Pobieram Moondream2 MMProj (800MB, to potrwa chwilę)...` });
    await downloadFileWithProgress(mmprojUrl, mmprojPath, "Pobieranie projektora wizji");
  }
  return { textModelPath, mmprojPath };
}

async function ensureVisionServer() {
  if (visionServerProcess) {
    try {
      const res = await fetch(`http://127.0.0.1:${VISION_PORT}/health`);
      if (res.ok) return;
    } catch {
      visionServerProcess = null;
    }
  }

  const { textModelPath, mmprojPath } = await ensureVisionSupport();
  const serverExe = getRuntimeServerExe();
  if (!serverExe) throw new Error("Nie znaleziono llama-server.exe dla wizji.");

  emit("activity", { detail: "Uruchamiam pomocniczy serwer wizji..." });
  const child = spawn(serverExe, [
    "-m", textModelPath,
    "--mmproj", mmprojPath,
    "--port", String(VISION_PORT),
    "--threads", "4",
    "--ctx-size", "2048",
    "--parallel", "1",
    "--no-display-prompt",
    "-ngl", "0" // Na razie CPU, żeby nie gryzło się z głównym modelem
  ], { windowsHide: true });

  visionServerProcess = child;
  child.on("exit", () => { if (visionServerProcess === child) visionServerProcess = null; });

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${VISION_PORT}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Serwer wizji nie wystartował w terminie.");
}

async function runVisionSupport(imagePath, prompt) {
  emit("status", { status: "vision-analysis", detail: "Pomocniczy VLM analizuje obraz..." });
  await ensureVisionServer();

  const imageBase64 = fs.readFileSync(imagePath).toString("base64");
  const finalPrompt = `Question: ${prompt}\n\nAnswer:`;

  const response = await fetch(`http://127.0.0.1:${VISION_PORT}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: finalPrompt,
      image_data: [{ data: imageBase64, id: 0 }],
      n_predict: 512,
      temperature: 0.2,
      stop: ["Question:", "User:", "<|im_end|>"]
    })
  });

  if (!response.ok) throw new Error(`Błąd serwera wizji: ${response.status}`);
  const data = await response.json();
  return data.content.trim();
}

let messages = createInitialMessages();

function compactMessages() {
  if (messages.length <= MAX_MESSAGES) return;
  // Keep system prompt + summarize old messages + keep recent ones
  const systemMsg = messages[0];
  const keepRecent = Math.min(Math.floor(MAX_MESSAGES * 0.6), MAX_MESSAGES - 2);
  const oldMessages = messages.slice(1, messages.length - keepRecent);
  const recentMessages = messages.slice(-keepRecent);
  // Create summary of old context
  let summaryParts = [];
  for (const msg of oldMessages) {
    if (msg.role === "user") {
      let rawText = "";
      if (Array.isArray(msg.content)) {
        rawText = msg.content.find(c => c.type === "text")?.text || "[Obraz]";
      } else {
        rawText = String(msg.content || "");
      }
      const text = rawText.slice(0, 150);
      if (text.startsWith("Wynik narzedzia")) continue; // skip tool results
      summaryParts.push(`Uzytkownik: ${text}`);
    } else if (msg.role === "assistant") {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.final) summaryParts.push(`Agent zakonczyl: ${String(parsed.final).slice(0, 100)}`);
        else if (parsed.note) summaryParts.push(`Agent: ${parsed.note}`);
      } catch { summaryParts.push(`Agent: ${String(msg.content).slice(0, 80)}`); }
    }
  }
  const summaryText = summaryParts.length > 0
    ? `[Kompaktowanie kontekstu] Podsumowanie wczesniejszej rozmowy:\n${summaryParts.slice(-10).join("\n")}`
    : "[Kompaktowanie kontekstu] Wczesniejsze wiadomosci zostaly usuniete.";
  const summaryMsg = { role: "user", content: summaryText };
  messages = [systemMsg, summaryMsg, ...recentMessages];
  emit("status", { status: "context-compacted", detail: `Skompaktowano kontekst: ${messages.length} wiadomosci.` });
}

async function runAgent(userText) {
  if (runInProgress) throw new Error("Agent juz pracuje.");
  runInProgress = true;
  runAbortController = new AbortController();
  const signal = runAbortController.signal;
  try {
    await validateCurrentWorkspaceRoot();
    await ensureServer(DEFAULT_PORT);
    
    let content;
    if (typeof userText === "object" && userText !== null && userText.imageBase64) {
      const promptText = userText.text || "Proszę przeanalizować załączony obraz.";
      emit("run-start", { text: userText.text || "[Wysłano obraz]" });
      
      const tempImgPath = path.join(os.tmpdir(), `endocode_vision_${Date.now()}.jpg`);
      await fsp.writeFile(tempImgPath, Buffer.from(userText.imageBase64, "base64"));
      
      try {
        const description = await runVisionSupport(tempImgPath, promptText);
        content = `[Użytkownik załączył obraz. Pomocniczy system wizji (Moondream2) przeanalizował go dla Ciebie z następującym wynikiem]:\n\n"${description}"\n\n[Polecenie użytkownika]:\n${promptText}`;
      } catch (err) {
        content = `[Użytkownik załączył obraz, ale system pomocniczy napotkał błąd podczas analizy: ${err.message}]\n\n[Polecenie]: ${promptText}`;
      } finally {
        fs.unlink(tempImgPath, () => {});
      }
    } else {
      content = userText;
      emit("run-start", { text: userText });
    }
    messages.push({ role: "user", content });

    const reasoning = getReasoningProfile();
    const failedModelIds = new Set();
    const effectiveMaxSteps = customModelSettings.maxSteps === 0
      ? 999999
      : (customModelSettings.maxSteps ?? reasoning.maxSteps);
    for (let step = 1; step <= effectiveMaxSteps; step += 1) {
      if (signal.aborted) throw new Error("Przerwano przez uzytkownika.");
      compactMessages();
      const stepLabel = effectiveMaxSteps >= 999999 ? `krok ${step} (∞)` : `krok ${step}/${effectiveMaxSteps}`;
      emit("status", { status: "model-thinking", detail: `${getModelConfig().displayName} — ${stepLabel}` });
      const action = await getNextActionWithRepair(signal, failedModelIds);
      if (action.note) emit("note", { note: action.note });

      if (action.final) {
        emit("final", { note: action.note || "", text: action.final });
        messages.push({ role: "assistant", content: JSON.stringify(action) });
        return { ok: true, final: action.final };
      }

      messages.push({ role: "assistant", content: JSON.stringify(action) });
      if (signal.aborted) throw new Error("Przerwano przez uzytkownika.");
      let toolPayload;
      try {
        const result = await executeTool(action);
        toolPayload = { ok: true, result };
      } catch (error) {
        if (signal.aborted) throw new Error("Przerwano przez uzytkownika.");
        const recoveryHint = getToolRecoveryHint(error, action);
        toolPayload = { ok: false, error: error.message, recoveryHint };
        emit("tool-result", { tool: action.tool, ok: false, error: error.message, recoveryHint });
      }

      messages.push({
        role: "user",
        content: `Wynik narzedzia. Kontynuuj albo zakoncz finalem. Jesli ok=false, masz obowiazek sprobowac obejscia z recoveryHint przed finalem:\n${JSON.stringify(toolPayload, null, 2)}`,
      });
    }
    const msg = "Osiagnieto limit krokow. Napisz, zeby kontynuowac.";
    emit("final", { text: msg });
    return { ok: true, final: msg };
  } catch (error) {
    if (signal.aborted) {
      emit("final", { text: "Przerwano zadanie." });
      return { ok: false, aborted: true };
    }
    let message = `Zatrzymalem zadanie kontrolowanie: ${error.message || String(error)}`;
    if (/image input is not supported/i.test(message)) {
      message = "Używany model to klasyczny LLM (brak obsługi obrazów). Użyj modelu z rodziny Vision (VLM) albo przesyłaj wyłącznie komendy tekstowe.";
    }
    emit("final", { text: message });
    messages.push({
      role: "assistant",
      content: JSON.stringify({ note: "Zadanie zatrzymane z powodu bledu.", final: message }),
    });
    return { ok: false, error: message };
  } finally {
    runInProgress = false;
    runAbortController = null;
    emit("run-end", {});
  }
}

function getState() {
  const modelConfig = getModelConfig();
  return {
    bielikHome: BIELIK_HOME,
    workspaceRoot,
    cwd: relativeToRoot(cwd),
    selectedModelId,
    selectedReasoning,
    reasoningLevels: REASONING_LEVELS,
    models: getModelsForUi(),
    modelConfig,
    modelPath: getModelPath(),
    serverExe: getRuntimeServerExe(),
    port: DEFAULT_PORT,
    customModelSettings,
    maxMessages: MAX_MESSAGES,
    accessLevel,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#1a1a2e",
    title: "EndoCode",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  const workspaceResult = await applyWorkspaceRoot(workspaceRoot, { create: false, skipSave: true });
  loadChatHistory();
  const settings = loadAppSettings();
  if (settings.accessLevel) accessLevel = settings.accessLevel;
  if (settings.customModelSettings) {
    Object.assign(customModelSettings, settings.customModelSettings);
  }
  if (settings.maxMessages) MAX_MESSAGES = Math.max(8, settings.maxMessages);
  if (workspaceResult.workspaceFallback?.used) saveAppSettings();
  createWindow();
  if (workspaceResult.workspaceFallback?.used) {
    emit("workspace-missing", workspaceResult.workspaceFallback);
  }
});

app.on("window-all-closed", async () => {
  await stopOwnedServer({ force: true });
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await stopOwnedServer({ force: true });
});

ipcMain.handle("app:state", () => ({ ...getState(), accessLevel }));
ipcMain.handle("app:select-workspace", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Wybierz workspace",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: workspaceRoot,
  });
  if (!result.canceled && result.filePaths[0]) {
    return ensureWorkspaceRoot(result.filePaths[0]);
  }
  return getState();
});
ipcMain.handle("app:restore-workspace", async (_event, root) => restoreWorkspaceRoot(root));
ipcMain.handle("app:reset-chat", () => {
  messages = createInitialMessages();
  currentChatId = null;
  emit("status", { status: "chat-reset", detail: "Wyczyszczono kontekst rozmowy." });
});
ipcMain.handle("app:set-model", async (_event, modelId) => {
  const model = loadModelCatalog().models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Nieznany model: ${modelId}`);
  if (model.kind !== "local-gguf") throw new Error(`${model.displayName} nie jest lokalnym modelem GGUF.`);
  selectedModelId = modelId;
  saveAppSettings();
  messages = createInitialMessages();
  if (serverOwned) await stopOwnedServer();
  emit("status", { status: "model-selected", detail: `Wybrano model: ${model.displayName}` });
  return getState();
});
ipcMain.handle("app:set-reasoning", (_event, level) => {
  if (!REASONING_LEVELS[level]) throw new Error(`Nieznana intensywnosc: ${level}`);
  selectedReasoning = level;
  saveAppSettings();
  messages = createInitialMessages();
  emit("status", { status: "reasoning-selected", detail: `Intensywnosc: ${REASONING_LEVELS[level].label}` });
  return getState();
});
ipcMain.handle("agent:send", (_event, payload) => runAgent(payload));
ipcMain.handle("agent:abort", () => {
  if (runAbortController) {
    runAbortController.abort();
    return { aborted: true };
  }
  return { aborted: false };
});
ipcMain.handle("agent:kill-server", () => killModelServerResources());
ipcMain.handle("approval:reply", (_event, approvalId, approved) => {
  ipcMain.emit(`approval:${approvalId}`, _event, approved);
});
ipcMain.handle("app:system-info", () => getSystemInfo());
ipcMain.handle("app:context-info", () => getContextInfo());
ipcMain.handle("app:set-access-level", (_event, level) => {
  if (level !== "sandbox" && level !== "full") throw new Error(`Nieznany poziom: ${level}`);
  accessLevel = level;
  saveAppSettings();
  emit("status", { status: "access-changed", detail: `Poziom dostepu: ${level === "full" ? "Pelny" : "Sandbox"}` });
  return { accessLevel };
});
ipcMain.handle("app:save-chat", (_event, session) => {
  const idx = chatHistory.findIndex((c) => c.id === session.id);
  if (idx >= 0) chatHistory[idx] = session;
  else chatHistory.unshift(session);
  if (chatHistory.length > 50) chatHistory.length = 50;
  saveChatHistory();
  return chatHistory;
});
ipcMain.handle("app:load-chats", () => loadChatHistory());
ipcMain.handle("app:delete-chat", (_event, chatId) => {
  chatHistory = chatHistory.filter((c) => c.id !== chatId);
  saveChatHistory();
  return chatHistory;
});
ipcMain.handle("app:list-skills", () => getSkillsForUi());
ipcMain.handle("app:install-skill", (_event, skillId) => installSkill(String(skillId ?? "")));
ipcMain.handle("app:uninstall-skill", (_event, skillId) => uninstallSkill(String(skillId ?? "")));
ipcMain.handle("app:install-recommended-skills", () => installRecommendedSkills());
ipcMain.handle("app:get-model-settings", () => ({
  ...customModelSettings,
  maxMessages: MAX_MESSAGES,
  // Include current effective values for display
  _effective: {
    temperature: customModelSettings.temperature ?? getReasoningProfile().temperature,
    maxTokens: customModelSettings.maxTokens ?? getReasoningProfile().maxTokens,
    maxSteps: customModelSettings.maxSteps ?? getReasoningProfile().maxSteps,
    contextTokens: customModelSettings.contextTokens ?? getModelConfig().contextTokens ?? 8192,
    gpuLayers: customModelSettings.gpuLayers ?? getModelConfig().gpuLayers ?? 99,
  },
}));
ipcMain.handle("app:set-model-settings", async (_event, settings) => {
  if (settings.temperature !== undefined) customModelSettings.temperature = settings.temperature;
  if (settings.maxTokens !== undefined) customModelSettings.maxTokens = settings.maxTokens;
  if (settings.maxSteps !== undefined) customModelSettings.maxSteps = settings.maxSteps;
  if (settings.topP !== undefined) customModelSettings.topP = settings.topP;
  if (settings.topK !== undefined) customModelSettings.topK = settings.topK;
  if (settings.repeatPenalty !== undefined) customModelSettings.repeatPenalty = settings.repeatPenalty;
  if (settings.contextTokens !== undefined) customModelSettings.contextTokens = settings.contextTokens;
  if (settings.gpuLayers !== undefined) customModelSettings.gpuLayers = settings.gpuLayers;
  if (settings.maxMessages !== undefined) MAX_MESSAGES = Math.max(8, settings.maxMessages);
  saveAppSettings();
  // If context/gpu changed, need server restart
  if (settings.contextTokens !== undefined || settings.gpuLayers !== undefined) {
    if (serverOwned) {
      await stopOwnedServer();
      emit("status", { status: "settings-changed", detail: "Zmieniono ustawienia serwera — restart przy nastepnym zapytaniu." });
    }
  }
  return { customModelSettings, maxMessages: MAX_MESSAGES };
});
ipcMain.handle("app:reset-model-settings", () => {
  customModelSettings = { temperature: null, maxTokens: null, maxSteps: null, topP: null, topK: null, repeatPenalty: null, contextTokens: null, gpuLayers: null };
  saveAppSettings();
  return { customModelSettings, maxMessages: MAX_MESSAGES };
});
