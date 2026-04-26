const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawn, execSync, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const os = require("node:os");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const https = require("node:https");
const { jsonrepair } = require("jsonrepair");
const JSZip = require("jszip");
const { createTelemetryMonitor } = require("./main/telemetry");

const DEFAULT_PORT = 8088;
const MAX_FILE_BYTES = 220000;
/** Modele czasem generuja absurdalnie dlugie "url" (padding zer) — odcinamy przed fetch. */
const MAX_TOOL_URL_LENGTH = 2048;
const MODEL_JSON_RETRY_LIMIT = 2;
const MODEL_CALL_RETRY_LIMIT = 1;
const MODEL_STREAM_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const SERVER_READY_PING_TIMEOUT_MS = 5000;
const SERVER_START_TIMEOUT_MIN_MS = 5 * 60 * 1000;
const SERVER_START_TIMEOUT_MAX_MS = 15 * 60 * 1000;
const PLAIN_CHAT_MAX_CHARS = 18000;
const PLAIN_CHAT_REPEAT_CHUNK_LIMIT = 40;
const SERVER_SHUTDOWN_TIMEOUT_MS = 6000;
const CHAT_WEB_LOOKUP_TIMEOUT_MS = 2500;
const CHAT_WEB_LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;
const CHAT_WEB_LOOKUP_MAX_ITEMS = 3;
const CHAT_WEB_PAGE_FETCH_TIMEOUT_MS = 2200;
const CHAT_WEB_PAGE_FETCH_MAX_SOURCES = 3;
const CHAT_WEB_PAGE_SNIPPET_CHARS = 320;
const CHAT_WEB_SEARCH_RESULT_LIMIT = 6;
const CHAT_WEB_HTML_SIGNAL_LIMIT = 10;
const CHAT_ATTACHMENT_MAX_BYTES = 6 * 1024 * 1024;
const CHAT_ATTACHMENT_TEXT_LIMIT = 12000;
const SAFE_RUNTIME_LIMITS = {
  contextMin: 4096,
  contextMax: 32768,
  threadsMin: 2,
  threadsMax: 16,
  threadsBatchMin: 2,
  threadsBatchMax: 20,
  batchMin: 256,
  batchMax: 1536,
  ubatchMin: 64,
  ubatchMax: 512,
  parallelMin: 1,
  parallelMax: 2,
};

/** Górny limit okna kontekstu (llama.cpp -c); suwak w UI do ~2.5 mln — realnie ogranicza RAM/VRAM. */
const MIN_CONTEXT_TOKENS = 1024;
const MAX_CONTEXT_TOKENS = 2_500_000;
/** Ile wiadomości w historii agenta przed kompaktowaniem (górny limit suwaka). */
const MAX_CHAT_MESSAGES_CAP = 32_768;

function clampContextTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 8192;
  return Math.min(MAX_CONTEXT_TOKENS, Math.max(MIN_CONTEXT_TOKENS, Math.round(n)));
}

function clampInt(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampMaxMessages(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 32;
  return Math.min(MAX_CHAT_MESSAGES_CAP, Math.max(8, Math.round(n)));
}

/** Zgodne z gałęziami w executeTool — nie zmieniaj nazw bez aktualizacji obu miejsc. */
const ALLOWED_TOOLS = new Set([
  "pwd",
  "cd",
  "ls",
  "read_file",
  "write_file",
  "mkdir",
  "replace_text",
  "create_pdf",
  "create_pptx",
  "create_docx",
  "run_powershell",
  "fetch_url",
  "extract_media",
  "download_file",
  "analyze_image",
]);

function allowedToolNamesList() {
  return [...ALLOWED_TOOLS].sort().join(", ");
}

const REASONING_LEVELS = {
  low: {
    label: "Szybko",
    maxSteps: 4,
    maxTokens: 700,
    temperature: 0.05,
    instruction: "Dzialaj maksymalnie szybko: minimum krokow i minimum tekstu. Preferuj najszybsza bezpieczna akcje i final jak najszybciej.",
  },
  medium: {
    label: "Normalnie",
    maxSteps: 10,
    maxTokens: 1300,
    temperature: 0.2,
    instruction: "Zrob krotki plan, przeczytaj istotne pliki, pracuj malymi krokami i uruchom waska weryfikacje.",
  },
  high: {
    label: "Dokladnie",
    maxSteps: 24,
    maxTokens: 8192,
    temperature: 0.2,
    instruction: "Poswiec wiecej krokow na rozpoznanie, minimalne poprawki, diagnostyke i testy. Note ma byc publiczne i zwiezle.",
  },
  max: {
    label: "Maksymalnie",
    maxSteps: 36,
    maxTokens: 16384,
    temperature: 0.25,
    instruction: "Maksymalna starannosc: rozpoznanie zaleznosci, etapowe wdrozenie, odzysk po bledach i mocniejsza weryfikacja. Jesli generujesz duze dokumenty (PDF/PPTX), rob to partiami: najpierw zapisz tresc w pliku .md/.html przez write_file (append), a na koncu wywolaj create_... podajac 'inputPath' do tego pliku.",
  },
};

const CORE_SYSTEM_PROMPT = `Jestes EndoCode: lokalnym agentem kodujacym i produkcyjnym.
Pracujesz na lokalnych modelach, lokalnych plikach i jawnych narzedziach. UI pokazuje uzytkownikowi Twoje kroki.

FORMAT ODPOWIEDZI:
- Odpowiadaj wylacznie jednym poprawnym obiektem JSON.
- Kazdy krok to dokladnie jedna akcja: albo {"tool":"...","args":{...}}, albo {"final":"..."}.
- Mozesz dodac "note", ale to publiczna, krotka informacja dla UI. Nie ujawniaj ukrytego toku rozumowania.
- Nie zwracaj tablic, Markdownu ani tekstu poza JSON.
- W stringach JSON nie uzywaj surowych nowych linii; uzyj \\n. W sciezkach uzywaj /.

DOSTEPNE NARZEDZIA:
- pwd {}
- cd {"path":"folder"}
- ls {"path":".","maxEntries":100}
- read_file {"path":"plik","maxBytes":30000}
- write_file {"path":"plik","content":"...","mode":"overwrite albo append"}
- mkdir {"path":"folder"}
- replace_text {"path":"plik","old":"tekst","new":"tekst","count":1}
- create_pdf {"path":"raport.pdf","title":"Tytul","markdown":"# Tresc"} albo {"path":"raport.pdf","title":"Tytul","html":"<h1>Tresc</h1>"}
- create_pptx {"path":"prez.pptx","title":"Tytul","markdown":"## Slajd 1\\n- punkt\\n## Slajd 2"}
- create_docx {"path":"dok.docx","title":"Tytul","markdown":"# Naglowek\\nAkapit"}
- run_powershell {"command":"npm test","timeout":60}
- fetch_url {"url":"https://example.com","timeout":15,"raw":false}
- extract_media {"url":"https://example.com","timeout":15}
- download_file {"url":"https://example.com/file.zip","path":"plik.zip"}
- analyze_image {"path":"plik.jpg"}

PODSTAWOWY LOOP:
1. Zrozum zadanie i sprawdz obecny folder.
2. Przed edycja istniejacego pliku przeczytaj istotny fragment.
3. Zmieniaj najmniejszy sensowny fragment. Nie przepisuj calego pliku dla drobnej poprawki.
4. Po bledzie przeczytaj dokladna tresc bledu, popraw przyczyne i sprobuj ponownie.
5. Po zmianie uruchom waska weryfikacje: syntax check, test, smoke test albo odczyt pliku.
6. Final po polsku: co zmieniono, jakie pliki, jaka weryfikacja.

ZASADY EDYCJI:
- Dla nowych plikow mozna uzyc write_file overwrite.
- Dla istniejacych plikow preferuj replace_text z precyzyjnym starym tekstem.
- Append stosuj do celowych dopisek albo dzielenia duzego pliku na fragmenty.
- Pelny overwrite istniejacego pliku tylko gdy plik jest generowany, bardzo maly, albo uzytkownik wyraznie chce przepisania.
- SyntaxError/build error: nie panikuj. Odczytaj plik i linie z bledu, popraw minimalny region, rerun tego samego checka.
- Jesli zapis sie nie uda, wyjasnij sobie powod z bledu: brak folderu -> mkdir; za dlugi content -> mniejsze chunki; odmowa -> alternatywa w workspace.

ZASADY NARZEDZI I SIECI:
- Nie zgaduj URL-i. Przy 404/403 wroc do strony glownej, dokumentacji, API albo uzyj extract_media.
- Nie powtarzaj identycznego nieudanego wywolania narzedzia. Po drugim podobnym bledzie zmien taktyke.
- Fetch nie renderuje JavaScriptu. Preferuj API JSON/CSV/XML lub stabilne zrodla.
- Pobieraj i zapisuj duze odpowiedzi jako pliki, nie wklejaj ich w JSON.

ARTEFAKTY:
- Dokumenty, PDF, PPTX, arkusze i obrazy tworz lokalnie.
- Dla dokumentow i prezentacji zachowaj zrodlo Markdown/HTML, gdy ulatwia to poprawki.
- Estetyka ma pasowac do zadania: narzedzia operacyjne maja byc czytelne i zwarte; prezentacje i strony moga byc bardziej dopracowane wizualnie.

ODZYSK PO PROBLEMACH:
- Brak narzedzia/dependency: sprawdz PATH albo lokalne skrypty; zaproponuj lub wykonaj lokalna instalacje tylko gdy to uzasadnione.
- Brak uprawnien: zapisz w bezpiecznym folderze workspace i powiedz dlaczego.
- Model zwrocil blad JSON: napraw tylko JSON kontraktu, nie zmieniaj celu zadania.
- Jesli nie da sie kontynuowac, final musi podac konkretna przyczyne i najblizszy mozliwy nastepny krok.`;

const AGENT_GUIDANCE_MAX_CHARS = 18000;

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
    instructions: "Dla DOCX preferuj narzedzie create_docx (markdown) po pip install python-docx; alternatywnie skrypt przez run_powershell lub zrodlo HTML/Markdown.",
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
    instructions: "Dla prezentacji dobierz pipeline do celu. Szybki funkcjonalny PPTX: create_pptx. Bogaty wizualnie deck: przygotuj Markdown/HTML i eksportuj lokalnym Marp/Slidev, jesli narzedzie jest dostepne. Zachowaj zrodlo obok wyniku.",
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
    instructions: "Dla obrazow pracuj lokalnie: SVG dla ikon/diagramow, HTML/CSS/canvas dla UI, albo lokalny generator jesli istnieje. Nie zakladaj chmurowego image API bez wyraznej prosby uzytkownika.",
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
let lastChatLookupQuery = "";
let accessLevel = "sandbox"; // "sandbox" or "full"
let chatHistory = [];
let currentChatId = null;
const VISION_PORT = 11435;
const telemetryMonitor = createTelemetryMonitor();

let activeDownloads = new Map();
const DEFAULT_MODEL_SETTINGS = {
  temperature: null,     // null = use reasoning profile default
  maxTokens: null,
  maxSteps: null,        // null = use reasoning profile, 0 = unlimited
  topP: null,
  topK: null,
  repeatPenalty: null,
  contextTokens: null,   // override for model context window
  gpuLayers: null,       // override for GPU offload layers
  maxMessages: null,     // override for compaction threshold
  threads: null,
  threadsBatch: null,
  batchSize: null,
  ubatchSize: null,
  parallel: null,
  flashAttention: null,
  cacheTypeK: null,
  cacheTypeV: null,
  reasoning: null,
  reasoningBudget: null,
  extraServerArgs: null,
};
let customModelSettingsByModelId = {};
const chatWebLookupCache = new Map();
const runtimeRecoveryStateByModelId = new Map();

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

function clampRuntimeNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function getServerStartupTimeoutMs(config = {}, contextTokens = 8192) {
  const sizeGB = Number(config.expectedBytes || 0) / 1073741824;
  const profile = getCachedModelProfile?.() || {};
  let timeoutMs = SERVER_START_TIMEOUT_MIN_MS;

  if (sizeGB >= 4) timeoutMs += 60_000;
  if (sizeGB >= 8) timeoutMs += 120_000;
  if (sizeGB >= 12) timeoutMs += 120_000;
  if (String(config.category || "").toLowerCase() === "large") timeoutMs += 120_000;

  if (Number(profile.ramGB || 0) > 0 && Number(profile.ramGB) < 24) timeoutMs += 120_000;
  if (Number(profile.ramGB || 0) > 0 && Number(profile.ramGB) < 16) timeoutMs += 120_000;
  if (String(profile.gpuBackendClass || "") === "cpu-only") timeoutMs += 120_000;
  if (String(profile.gpuBackendClass || "") === "intel-igpu") timeoutMs += 60_000;
  if (Number(contextTokens || 0) > 32768) timeoutMs += 60_000;
  if (Number(contextTokens || 0) > 65536) timeoutMs += 60_000;

  return Math.min(SERVER_START_TIMEOUT_MAX_MS, Math.max(SERVER_START_TIMEOUT_MIN_MS, timeoutMs));
}

function normalizeRuntimePatch(rawPatch = {}) {
  const patch = {};
  if (rawPatch.contextTokens != null) patch.contextTokens = clampContextTokens(rawPatch.contextTokens);
  if (rawPatch.gpuLayers != null) patch.gpuLayers = clampRuntimeNumber(rawPatch.gpuLayers, 0, 99);
  if (rawPatch.threads != null) patch.threads = clampRuntimeNumber(rawPatch.threads, 1, 128);
  if (rawPatch.threadsBatch != null) patch.threadsBatch = clampRuntimeNumber(rawPatch.threadsBatch, 1, 256);
  if (rawPatch.batchSize != null) patch.batchSize = clampRuntimeNumber(rawPatch.batchSize, 32, 4096);
  if (rawPatch.ubatchSize != null) patch.ubatchSize = clampRuntimeNumber(rawPatch.ubatchSize, 16, 2048);
  if (rawPatch.parallel != null) patch.parallel = clampRuntimeNumber(rawPatch.parallel, 1, 8);
  if (rawPatch.flashAttention != null) patch.flashAttention = String(rawPatch.flashAttention);
  return patch;
}

function buildRuntimeDegradationSteps(modelId = selectedModelId) {
  const effective = getEffectiveSettingsForModel(modelId);
  const c0 = clampContextTokens(effective.contextTokens ?? 8192);
  const g0 = clampRuntimeNumber(effective.gpuLayers ?? 0, 0, 99) ?? 0;
  const t0 = clampRuntimeNumber(effective.threads ?? (os.cpus().length || 8), 1, 128) ?? 8;
  const tb0 = clampRuntimeNumber(effective.threadsBatch ?? (t0 + 4), 1, 256) ?? (t0 + 4);
  const b0 = clampRuntimeNumber(effective.batchSize ?? 1024, 32, 4096) ?? 1024;
  const ub0 = clampRuntimeNumber(effective.ubatchSize ?? 512, 16, 2048) ?? 512;

  return [
    normalizeRuntimePatch({
      contextTokens: Math.max(8192, Math.floor(c0 * 0.75)),
      gpuLayers: Math.max(0, Math.floor(g0 * 0.7)),
      threadsBatch: Math.max(4, Math.min(tb0, t0 + 2)),
      batchSize: Math.max(512, Math.floor(b0 * 0.75)),
      ubatchSize: Math.max(128, Math.floor(ub0 * 0.75)),
    }),
    normalizeRuntimePatch({
      contextTokens: Math.max(4096, Math.floor(c0 * 0.5)),
      gpuLayers: Math.max(0, Math.floor(g0 * 0.45)),
      threads: Math.max(2, Math.min(t0, 12)),
      threadsBatch: Math.max(4, Math.min(tb0, 12)),
      batchSize: Math.max(256, Math.floor(b0 * 0.5)),
      ubatchSize: Math.max(64, Math.floor(ub0 * 0.5)),
    }),
    normalizeRuntimePatch({
      contextTokens: Math.max(4096, Math.floor(c0 * 0.35)),
      gpuLayers: 0,
      threads: Math.max(2, Math.min(t0, 8)),
      threadsBatch: Math.max(4, Math.min(tb0, 8)),
      batchSize: 256,
      ubatchSize: 64,
      parallel: 1,
    }),
  ];
}

async function tryApplyRuntimeDegradation(error, step = null) {
  const model = getModelConfig();
  const modelId = model?.id || selectedModelId;
  if (!modelId) return false;

  const state = runtimeRecoveryStateByModelId.get(modelId) || {
    steps: buildRuntimeDegradationSteps(modelId),
    nextIndex: 0,
  };
  if (state.nextIndex >= state.steps.length) return false;

  const patch = state.steps[state.nextIndex];
  state.nextIndex += 1;
  runtimeRecoveryStateByModelId.set(modelId, state);

  if (!patch || !Object.keys(patch).length) return false;
  setModelSettingsForId(modelId, patch);
  emit("status", {
    status: "model-runtime-degrade",
    detail: `Model API 500: zmniejszam obciazenie runtime (proba ${state.nextIndex}/${state.steps.length}) i restartuje model.`,
    step,
  });
  await stopOwnedServer({ force: true });
  await ensureServer(DEFAULT_PORT);
  return true;
}

function resetRuntimeRecoveryState(modelId = selectedModelId) {
  if (modelId) runtimeRecoveryStateByModelId.delete(modelId);
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

const PERF_WARN_MS = 120;
function logPerf(label, startedAt) {
  const elapsed = Date.now() - startedAt;
  if (elapsed >= PERF_WARN_MS) {
    console.warn(`[perf] ${label} ${elapsed}ms`);
  }
}

let modelCatalogCache = null;
let modelCatalogCacheAt = 0;
const MODEL_CATALOG_CACHE_TTL_MS = 1200;

function loadModelCatalog() {
  const cacheAge = Date.now() - modelCatalogCacheAt;
  if (modelCatalogCache && cacheAge >= 0 && cacheAge < MODEL_CATALOG_CACHE_TTL_MS) {
    return JSON.parse(JSON.stringify(modelCatalogCache));
  }
  const startedAt = Date.now();
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
  const catalog = readJsonFile(path.join(BIELIK_HOME, "config", "models.json"), fallback);
  if (!Array.isArray(catalog.models)) catalog.models = [];
  for (const preset of loadModelPresets()) {
    if (!catalog.models.some((model) => model.id === preset.id)) {
      catalog.models.push(createPresetModelConfig(preset));
    }
  }
  // Filter out Claude Opus (API only) as requested
  catalog.models = catalog.models.filter(m => m.id !== "claude-opus-4-5-api");
  modelCatalogCache = catalog;
  modelCatalogCacheAt = Date.now();
  logPerf("loadModelCatalog", startedAt);
  return catalog;
}

function loadModelPresets() {
  const data = readJsonFile(path.join(BIELIK_HOME, "config", "model-presets.json"), { models: [] });
  if (!Array.isArray(data.models)) return [];
  return data.models
    .filter((preset) => preset && typeof preset === "object")
    .filter((preset) => Boolean(preset.id) && Boolean(preset.file || preset.fileName))
    .map((preset) => ({ ...preset }));
}

function applyRuntimeSafetyGuards(rawConfig = {}, modelMeta = {}) {
  const profile = getCachedModelProfile();
  const sizeGB = Number(modelMeta.expectedBytes || 0) / 1073741824;
  const category = String(modelMeta.category || rawConfig.category || "").toLowerCase();

  const config = { ...rawConfig };
  config.contextTokens = clampContextTokens(clampInt(
    config.contextTokens ?? 8192,
    SAFE_RUNTIME_LIMITS.contextMin,
    SAFE_RUNTIME_LIMITS.contextMax,
    8192,
  ));
  if (category !== "small" || sizeGB >= 6) config.contextTokens = Math.min(config.contextTokens, 16384);
  if (sizeGB >= 10 || category === "large") config.contextTokens = Math.min(config.contextTokens, 8192);
  if (Number(profile?.ramGB || 0) > 0 && Number(profile.ramGB) < 24) config.contextTokens = Math.min(config.contextTokens, 8192);

  config.threads = clampInt(
    config.threads ?? (os.cpus().length || 8),
    SAFE_RUNTIME_LIMITS.threadsMin,
    SAFE_RUNTIME_LIMITS.threadsMax,
    8,
  );
  config.threadsBatch = clampInt(
    config.threadsBatch ?? (config.threads + 2),
    SAFE_RUNTIME_LIMITS.threadsBatchMin,
    SAFE_RUNTIME_LIMITS.threadsBatchMax,
    config.threads + 2,
  );
  if (config.threadsBatch < config.threads) config.threadsBatch = config.threads;

  config.batchSize = clampInt(
    config.batchSize ?? 1024,
    SAFE_RUNTIME_LIMITS.batchMin,
    SAFE_RUNTIME_LIMITS.batchMax,
    1024,
  );
  config.ubatchSize = clampInt(
    config.ubatchSize ?? 256,
    SAFE_RUNTIME_LIMITS.ubatchMin,
    SAFE_RUNTIME_LIMITS.ubatchMax,
    256,
  );
  if (config.ubatchSize > config.batchSize) config.ubatchSize = Math.min(config.batchSize, SAFE_RUNTIME_LIMITS.ubatchMax);
  config.parallel = clampInt(
    config.parallel ?? 1,
    SAFE_RUNTIME_LIMITS.parallelMin,
    SAFE_RUNTIME_LIMITS.parallelMax,
    1,
  );

  config.gpuLayers = clampInt(config.gpuLayers ?? 0, 0, 99, 0);
  if (Number(profile?.vramGB || 0) <= 0 || String(profile?.gpuBackendClass || "") === "cpu-only") {
    config.gpuLayers = 0;
  }
  config.gpuLayerFallbacks = createGpuLayerFallbacks(config.gpuLayers, profile?.gpuBackendClass || "cpu-only");

  config.flashAttention = String(config.flashAttention ?? "on");
  config.cacheTypeK = config.cacheTypeK || "q8_0";
  config.cacheTypeV = config.cacheTypeV || "q8_0";
  return config;
}

function createPresetModelConfig(preset) {
  const fileName = safeModelFileName(preset.file || preset.fileName);
  const runtimeConfig = createRuntimeModelConfig({
    displayName: preset.displayName,
    file: fileName,
    expectedBytes: preset.expectedBytes,
    category: preset.category,
    contextTokens: preset.contextTokens,
    gpuLayers: preset.gpuLayers,
  });
  const mergedRuntime = {
    ...runtimeConfig,
    contextTokens: preset.contextTokens ?? runtimeConfig.contextTokens,
    gpuLayers: preset.gpuLayers ?? runtimeConfig.gpuLayers,
    threads: preset.threads ?? runtimeConfig.threads,
    threadsBatch: preset.threadsBatch ?? runtimeConfig.threadsBatch,
    batchSize: preset.batchSize ?? runtimeConfig.batchSize,
    ubatchSize: preset.ubatchSize ?? runtimeConfig.ubatchSize,
    parallel: preset.parallel ?? runtimeConfig.parallel,
    flashAttention: preset.flashAttention ?? runtimeConfig.flashAttention,
    cacheTypeK: preset.cacheTypeK ?? runtimeConfig.cacheTypeK,
    cacheTypeV: preset.cacheTypeV ?? runtimeConfig.cacheTypeV,
  };
  const safeRuntime = applyRuntimeSafetyGuards(mergedRuntime, {
    expectedBytes: preset.expectedBytes,
    category: preset.category || runtimeConfig.category,
  });
  return {
    id: preset.id || createModelId(fileName, preset.source || "preset"),
    displayName: preset.displayName || fileName.replace(/\.gguf$/i, "").replace(/[-_.]/g, " "),
    kind: "local-gguf",
    serverModel: preset.serverModel || fileName.replace(/\.gguf$/i, "").toLowerCase(),
    file: `models/${fileName}`,
    expectedBytes: Number(preset.expectedBytes || 0),
    source: preset.source,
    sourceType: preset.sourceType || "huggingface",
    category: preset.category || safeRuntime.category || runtimeConfig.category,
    preset: true,
    description: preset.description || "Preset modelu GGUF.",
    ...safeRuntime,
  };
}

function saveModelCatalog(catalog) {
  writeJsonFile(path.join(BIELIK_HOME, "config", "models.json"), {
    ...catalog,
    models: (catalog.models || []).filter((model) => !model.preset),
  });
  modelCatalogCache = null;
  modelCatalogCacheAt = 0;
}

async function pathExistsAsync(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function syncCatalogWithModelFiles(catalog) {
  if (!catalog || !Array.isArray(catalog.models)) return { removedModelIds: [] };
  const removedModelIds = [];
  const syncedModels = [];

  for (const model of catalog.models) {
    if (model.kind !== "local-gguf" || !model.file) {
      syncedModels.push(model);
      continue;
    }
    if (activeDownloads.has(model.id)) {
      syncedModels.push(model);
      continue;
    }
    const modelPath = path.resolve(BIELIK_HOME, model.file);
    if (await pathExistsAsync(modelPath)) {
      syncedModels.push(model);
      continue;
    }
    // Keep entries that are valid download candidates (not downloaded yet).
    const hasDownloadSource = Boolean(
      String(model.downloadUrl || "").trim() ||
      String(model.source || "").trim() ||
      model.preset,
    );
    if (hasDownloadSource) {
      syncedModels.push(model);
      continue;
    }
    removedModelIds.push(model.id);
  }

  if (removedModelIds.length > 0) {
    catalog.models = syncedModels;
    if (removedModelIds.includes(selectedModelId)) {
      selectedModelId = catalog.defaultModelId;
      if (!catalog.models.some((model) => model.id === selectedModelId)) {
        selectedModelId = catalog.models[0]?.id || selectedModelId;
      }
      saveAppSettings();
    }
    saveModelCatalog(catalog);
  }

  return { removedModelIds };
}

function loadAppSettings() {
  return readJsonFile(path.join(BIELIK_HOME, "config", "endocode-state.json"), {});
}

function saveAppSettings() {
  writeJsonFile(path.join(BIELIK_HOME, "config", "endocode-state.json"), {
    selectedModelId,
    reasoningLevel: selectedReasoning,
    accessLevel,
    customModelSettingsByModelId,
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

function probeGpuInfo() {
  return telemetryMonitor.probeGpuInfo();
}

function getSystemInfo() {
  return telemetryMonitor.getSystemInfo();
}

function getHardwareModelProfile() {
  return telemetryMonitor.getHardwareModelProfile();
}

function inferParamB(...values) {
  const text = values.filter(Boolean).join(" ").toLowerCase();
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*b\b/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  if (!matches.length) return null;
  return Math.max(...matches);
}

function inferQuant(fileName = "") {
  const text = String(fileName).toUpperCase();
  const match = text.match(/(?:^|[-_.])((?:IQ\d+_[A-Z0-9]+)|(?:Q\d(?:_\d)?(?:_[A-Z0-9]+)?))/);
  return match ? match[1] : "";
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "";
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(1)} GB`;
  if (value >= 1048576) return `${(value / 1048576).toFixed(0)} MB`;
  return `${value} B`;
}

function scoreModelFit({ name, description, fileName, sizeBytes }, profile) {
  const paramB = inferParamB(name, description, fileName);
  const quant = inferQuant(fileName);
  const sizeGB = Number(sizeBytes || 0) / 1073741824;
  let score = 35;
  const notes = [];

  if (paramB) {
    if (paramB <= profile.maxParamB) {
      score += 24;
      notes.push(`${paramB}B pasuje do profilu ${profile.target}`);
    } else if (paramB <= profile.maxParamB * 1.6 && profile.ramGB >= 32) {
      score += 8;
      notes.push(`${paramB}B ruszy, ale może być wolniejszy`);
    } else {
      score -= 24;
      notes.push(`${paramB}B wygląda za ciężko dla tej maszyny`);
    }
  }

  if (sizeGB > 0) {
    if (profile.fastBudgetGB > 0 && sizeGB <= profile.fastBudgetGB) {
      score += 24;
      notes.push(`plik ${sizeGB.toFixed(1)} GB mieści się w VRAM`);
    } else if (sizeGB <= profile.memoryBudgetGB) {
      score += 16;
      notes.push(`plik ${sizeGB.toFixed(1)} GB mieści się w RAM`);
    } else {
      score -= 28;
      notes.push(`plik ${sizeGB.toFixed(1)} GB przekracza komfortowy budżet RAM`);
    }
  }

  if (/Q4_K_M|Q5_K_M|Q4_0|IQ4/i.test(quant)) score += 12;
  else if (/Q8|F16|BF16/i.test(quant)) score -= 8;

  return {
    score,
    recommended: score >= 62,
    paramB,
    quant,
    fitLabel: notes[0] || `Profil: ${profile.target}`,
    fitNotes: notes,
  };
}

function getCachedModelProfile() {
  return telemetryMonitor.getCachedModelProfile();
}

function inferModelCategory({ file, displayName, expectedBytes, category }) {
  if (category) return category;
  const paramB = inferParamB(displayName, file);
  const sizeGB = Number(expectedBytes || 0) / 1073741824;
  if (paramB >= 24 || sizeGB >= 13) return "large";
  if (paramB >= 8 || sizeGB >= 5) return "medium";
  return "small";
}

function createGpuLayerFallbacks(gpuLayers, gpuBackendClass = "cpu-only") {
  const layers = Number(gpuLayers || 0);
  if (gpuBackendClass === "intel-igpu") {
    if (layers >= 20) return [12, 8, 4, 0];
    if (layers >= 8) return [4, 0];
    return [0];
  }
  if (gpuBackendClass === "amd") {
    if (layers >= 80) return [48, 32, 20, 12];
    if (layers >= 40) return [28, 20, 12, 8];
    if (layers >= 16) return [12, 8, 4, 0];
    return [4, 0];
  }
  if (layers >= 90) return [64, 48, 32];
  if (layers >= 60) return [48, 32, 16];
  if (layers >= 32) return [28, 20, 12];
  if (layers >= 16) return [12, 8, 4];
  return [0];
}

function createRuntimeModelConfig(model = {}) {
  const profile = getCachedModelProfile();
  const expectedBytes = Number(model.expectedBytes || 0);
  const sizeGB = expectedBytes / 1073741824;
  const category = inferModelCategory({
    file: model.file,
    displayName: model.displayName,
    expectedBytes,
    category: model.category,
  });

  let contextTokens = category === "small" ? 32768 : category === "medium" ? 16384 : 8192;
  if (sizeGB > 13 && category !== "large") contextTokens = 8192;
  if (profile.ramGB < 24 && category !== "small") contextTokens = Math.min(contextTokens, 8192);
  if (Number.isFinite(Number(model.contextTokens)) && Number(model.contextTokens) > 0) {
    contextTokens = clampContextTokens(model.contextTokens);
  }

  let gpuLayers = 0;
  if (profile.gpuBackendClass === "nvidia") {
    if (!sizeGB || sizeGB <= profile.vramGB * 0.72) gpuLayers = 99;
    else if (sizeGB <= profile.vramGB * 0.95) gpuLayers = 64;
    else if (sizeGB <= profile.vramGB * 1.2) gpuLayers = 36;
    else gpuLayers = profile.vramGB >= 10 ? 24 : 12;
  } else if (profile.gpuBackendClass === "amd") {
    if (!sizeGB || sizeGB <= profile.vramGB * 0.7) gpuLayers = 64;
    else if (sizeGB <= profile.vramGB * 1.0) gpuLayers = 32;
    else gpuLayers = profile.vramGB >= 8 ? 16 : 8;
  } else if (profile.gpuBackendClass === "intel-igpu") {
    gpuLayers = profile.vramGB >= 4 ? 8 : 0;
  }
  if (Number.isFinite(Number(model.gpuLayers)) && Number(model.gpuLayers) >= 0) {
    gpuLayers = Number(model.gpuLayers);
  }

  return applyRuntimeSafetyGuards({
    category,
    contextTokens,
    gpuLayers,
    gpuLayerFallbacks: createGpuLayerFallbacks(gpuLayers, profile.gpuBackendClass),
    threads: Math.max(2, Math.min(16, os.cpus().length || 8)),
    threadsBatch: Math.max(2, Math.min(20, (os.cpus().length || 8) + 4)),
    batchSize: category === "small" ? 2048 : 1024,
    ubatchSize: 512,
    parallel: 1,
    flashAttention: "on",
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
  }, { expectedBytes, category });
}

function normalizeGgufFile(file, profile, context = {}) {
  const fileName = file.rfilename || file.Path || file.path || file.name || file.Name || "";
  const sizeBytes = Number(file.size || file.Size || file.file_size || file.fileSize || 0);
  const fit = scoreModelFit({
    name: context.name,
    description: context.description,
    fileName,
    sizeBytes,
  }, profile);
  return {
    name: fileName,
    sizeBytes,
    sizeLabel: formatBytes(sizeBytes),
    quant: fit.quant,
    fit,
  };
}

function chooseBestGgufFile(files, profile, context = {}) {
  return files
    .filter((file) => /\.gguf$/i.test(file.name || ""))
    .filter((file) => !/mmproj|imatrix/i.test(file.name || ""))
    .map((file) => ({
      ...file,
      fit: file.fit || scoreModelFit({
        name: context.name,
        description: context.description,
        fileName: file.name,
        sizeBytes: file.sizeBytes,
      }, profile),
    }))
    .sort((a, b) => (b.fit.score - a.fit.score) || ((b.sizeBytes || 0) - (a.sizeBytes || 0)))[0] || null;
}

function encodeRepoPath(repoId) {
  return String(repoId || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function safeModelFileName(fileName) {
  const clean = path.basename(String(fileName || "").split("?")[0]);
  if (!/\.gguf$/i.test(clean)) throw new Error("Plik modelu musi mieć rozszerzenie .gguf.");
  return clean.replace(/[<>:"\\|?*]/g, "_");
}

function createModelId(fileName, source = "") {
  const base = String(fileName || "").replace(/\.gguf$/i, "");
  const suffix = String(source || "").split("/").slice(-2).join("-");
  return `${base}-${suffix}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

async function importLocalModelFromFile(input = {}) {
  const payload = typeof input === "object" && input !== null ? input : {};
  let sourcePath = String(payload.filePath || "").trim();
  if (!sourcePath) {
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: "Wybierz plik modelu GGUF",
      properties: ["openFile"],
      filters: [
        { name: "GGUF models", extensions: ["gguf", "guff"] },
        { name: "All files", extensions: ["*"] },
      ],
      defaultPath: path.join(BIELIK_HOME, "models"),
    });
    if (pick.canceled || !pick.filePaths?.[0]) return { ok: false, canceled: true };
    sourcePath = pick.filePaths[0];
  }

  const ext = path.extname(sourcePath).toLowerCase();
  if (ext !== ".gguf" && ext !== ".guff") {
    throw new Error("Wskaż plik .gguf lub .guff.");
  }
  await fsp.access(sourcePath, fs.constants.R_OK);

  const srcStat = await fsp.stat(sourcePath);
  if (!srcStat.isFile()) throw new Error("Wybrana ścieżka nie jest plikiem.");
  const fileName = safeModelFileName(path.basename(sourcePath).replace(/\.guff$/i, ".gguf"));
  const modelDir = path.join(BIELIK_HOME, "models");
  await fsp.mkdir(modelDir, { recursive: true });

  let finalFileName = fileName;
  let targetPath = path.join(modelDir, finalFileName);
  let suffix = 1;
  while (await pathExistsAsync(targetPath)) {
    const parsed = path.parse(fileName);
    finalFileName = `${parsed.name}-${suffix}${parsed.ext || ".gguf"}`;
    targetPath = path.join(modelDir, finalFileName);
    suffix += 1;
  }
  await fsp.copyFile(sourcePath, targetPath);

  const catalog = loadModelCatalog();
  const displayName = String(payload.displayName || "").trim() || finalFileName.replace(/\.gguf$/i, "").replace(/[-_.]/g, " ");
  const description = String(payload.description || "").trim() || "Model zaimportowany ręcznie z lokalnego pliku GGUF.";
  const id = createModelId(finalFileName, "manual");
  if (catalog.models.some((m) => m.id === id)) {
    throw new Error("Model o takim ID już istnieje w katalogu.");
  }

  const runtimeConfig = createRuntimeModelConfig({
    file: finalFileName,
    displayName,
    expectedBytes: srcStat.size,
    description,
  });

  const newModel = {
    id,
    displayName,
    description,
    kind: "local-gguf",
    serverModel: id,
    file: `models/${finalFileName}`,
    expectedBytes: srcStat.size,
    source: "manual-import",
    sourceType: "manual",
    ...runtimeConfig,
  };
  catalog.models.push(newModel);
  saveModelCatalog(catalog);
  setModelSettingsForId(id, {
    maxMessages: 32,
    contextTokens: runtimeConfig.contextTokens,
    gpuLayers: runtimeConfig.gpuLayers,
    threads: runtimeConfig.threads,
    threadsBatch: runtimeConfig.threadsBatch,
    batchSize: runtimeConfig.batchSize,
    ubatchSize: runtimeConfig.ubatchSize,
    parallel: runtimeConfig.parallel,
    flashAttention: runtimeConfig.flashAttention,
    cacheTypeK: runtimeConfig.cacheTypeK,
    cacheTypeV: runtimeConfig.cacheTypeV,
  });
  saveAppSettings();
  return { ok: true, model: newModel };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Accept": "application/json",
      "User-Agent": "EndoCode-Desktop-App",
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text.slice(0, 160)}` : ""}`);
  }
  return res.json();
}

function normalizeWebQuery(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function truncateAttachmentText(text, limit = CHAT_ATTACHMENT_TEXT_LIMIT) {
  const value = String(text || "").replace(/\0/g, "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[skrócono załącznik]`;
}

function decodeBase64Attachment(dataBase64) {
  const raw = String(dataBase64 || "");
  return Buffer.from(raw, "base64");
}

function xmlToVisibleText(xml = "") {
  return String(xml || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPdfTextLight(buffer) {
  const raw = buffer.toString("latin1");
  const chunks = [];
  const regex = /\(([^()]{2,240})\)\s*Tj/g;
  let match;
  while ((match = regex.exec(raw))) {
    const text = match[1]
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\n/g, " ")
      .replace(/\\r/g, " ");
    if (/[a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(text)) chunks.push(text);
    if (chunks.length >= 400) break;
  }
  return truncateAttachmentText(chunks.join(" "));
}

function commandExists(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  return r.status === 0 && !r.error;
}

function runCommandOutput(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 20000,
    cwd: options.cwd,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return "";
  return String(r.stdout || "").trim();
}

function extractPdfTextViaPoppler(buffer) {
  if (!commandExists("pdftotext")) return "";
  const tempPath = path.join(os.tmpdir(), `endocode-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tempPath, buffer);
    const out = runCommandOutput("pdftotext", ["-q", "-enc", "UTF-8", tempPath, "-"], { timeout: 25000 });
    return truncateAttachmentText(out);
  } catch {
    return "";
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }
}

function extractPdfTextViaOcr(buffer) {
  if (!commandExists("pdftoppm") || !commandExists("tesseract")) return "";
  const tempDir = path.join(os.tmpdir(), `endocode-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tempPdf = path.join(tempDir, "input.pdf");
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(tempPdf, buffer);
    const prefix = path.join(tempDir, "page");
    const convert = spawnSync("pdftoppm", ["-f", "1", "-l", "3", "-png", tempPdf, prefix], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 45000,
      cwd: tempDir,
      env: process.env,
    });
    if (convert.error || convert.status !== 0) return "";
    const files = fs.readdirSync(tempDir)
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .sort()
      .slice(0, 3);
    const parts = [];
    for (const file of files) {
      const full = path.join(tempDir, file);
      const out = runCommandOutput("tesseract", [full, "stdout", "-l", "eng+pol"], { timeout: 30000 });
      if (out) parts.push(out);
    }
    return truncateAttachmentText(parts.join("\n"));
  } catch {
    return "";
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function extractPdfTextEnhanced(buffer) {
  const light = extractPdfTextLight(buffer);
  if (light && light.length >= 220) return light;
  const poppler = extractPdfTextViaPoppler(buffer);
  if (poppler && poppler.length >= 220) return poppler;
  const ocr = extractPdfTextViaOcr(buffer);
  if (ocr) return ocr;
  return light || poppler || "";
}

async function extractTextFromZipOffice(buffer, ext) {
  const zip = await JSZip.loadAsync(buffer);
  if (ext === ".docx") {
    const doc = zip.file("word/document.xml");
    if (!doc) return "";
    const xml = await doc.async("string");
    return truncateAttachmentText(xmlToVisibleText(xml));
  }
  if (ext === ".pptx") {
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((a, b) => {
        const ai = Number((a.match(/slide(\d+)\.xml/i) || [0, 0])[1]);
        const bi = Number((b.match(/slide(\d+)\.xml/i) || [0, 0])[1]);
        return ai - bi;
      })
      .slice(0, 20);
    const parts = [];
    for (const name of slideNames) {
      const xml = await zip.file(name).async("string");
      const text = xmlToVisibleText(xml);
      if (text) parts.push(text);
    }
    return truncateAttachmentText(parts.join("\n"));
  }
  if (ext === ".xlsx") {
    const sharedStringsXml = zip.file("xl/sharedStrings.xml") ? await zip.file("xl/sharedStrings.xml").async("string") : "";
    const shared = [];
    if (sharedStringsXml) {
      const regex = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let match;
      while ((match = regex.exec(sharedStringsXml))) shared.push(xmlToVisibleText(match[1]));
    }
    const sheetNames = Object.keys(zip.files)
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .sort()
      .slice(0, 10);
    const values = [];
    for (const sheetName of sheetNames) {
      const xml = await zip.file(sheetName).async("string");
      const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let c;
      while ((c = cellRegex.exec(xml))) {
        const attrs = c[1] || "";
        const body = c[2] || "";
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        if (!vMatch) continue;
        let val = xmlToVisibleText(vMatch[1]);
        if (/t="s"/.test(attrs)) {
          const idx = Number(val);
          if (Number.isFinite(idx) && shared[idx] != null) val = shared[idx];
        }
        if (val) values.push(val);
        if (values.length >= 3000) break;
      }
      if (values.length >= 3000) break;
    }
    return truncateAttachmentText(values.join("\n"));
  }
  return "";
}

async function extractAttachmentText(attachment) {
  const name = String(attachment?.name || "attachment");
  const mimeType = String(attachment?.mimeType || "application/octet-stream");
  const size = Number(attachment?.size || 0);
  const dataBase64 = String(attachment?.dataBase64 || "");
  if (!dataBase64) return { ok: false, reason: "Brak danych pliku." };
  if (size > CHAT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, reason: `Plik jest za duży (${Math.round(size / 1024 / 1024)} MB). Limit: ${Math.round(CHAT_ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB.` };
  }
  const ext = path.extname(name).toLowerCase();
  const buffer = decodeBase64Attachment(dataBase64);
  let text = "";
  if (ext === ".txt" || ext === ".csv" || ext === ".md" || ext === ".log" || ext === ".json") {
    text = truncateAttachmentText(buffer.toString("utf8"));
  } else if (ext === ".pdf") {
    text = await extractPdfTextEnhanced(buffer);
  } else if (ext === ".docx" || ext === ".pptx" || ext === ".xlsx") {
    text = await extractTextFromZipOffice(buffer, ext);
  } else if (mimeType.startsWith("text/")) {
    text = truncateAttachmentText(buffer.toString("utf8"));
  } else {
    return { ok: false, reason: `Nieobsługiwany format ${ext || mimeType} w trybie lekkim.` };
  }
  if (!text) return { ok: false, reason: "Nie udało się wyciągnąć czytelnego tekstu z pliku." };
  return { ok: true, name, ext, mimeType, size, text };
}

function isRepeatPrompt(text) {
  const q = String(text || "").trim().toLowerCase();
  if (!q) return false;
  return /^(jeszcze raz|ponow|ponów|retry|spróbuj ponownie|sprobuj ponownie|again|powtorz|powtórz)$/.test(q);
}

const WEB_LOOKUP_STOPWORDS_PL = new Set([
  "ale", "co", "dokladnie", "dokładnie", "na", "tej", "stronie", "jakies", "jakieś", "cokolwiek", "szczegolowo", "szczegółowo",
  "mi", "powiedz", "powiedzisz", "prosze", "proszę", "czy", "i", "oraz", "to", "ten", "ta", "te", "tam", "tu", "w", "z",
  "o", "u", "do", "dla", "po", "od", "się", "sie", "jest", "są", "sa", "by", "aby",
]);

function buildWebLookupCandidates(query, preferredQuery = "") {
  const normalized = normalizeWebQuery(query);
  const preferred = normalizeWebQuery(preferredQuery);
  if (!normalized && !preferred) return [];
  const cleaned = normalized
    .replace(/[!?.,;:()[\]{}"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => word.length >= 3)
    .filter((word) => !WEB_LOOKUP_STOPWORDS_PL.has(word.toLowerCase()))
    .slice(0, 12);

  const candidates = [];
  if (preferred) candidates.push(preferred);
  if (words.length) candidates.push(words.join(" "));
  if (normalized) candidates.push(normalized);
  return [...new Set(candidates.map((v) => v.slice(0, 140).trim()).filter(Boolean))];
}

function extractLookupKeywords(text) {
  return normalizeWebQuery(text)
    .toLowerCase()
    .replace(/[!?.,;:()[\]{}"'`]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => word.length >= 4)
    .filter((word) => !WEB_LOOKUP_STOPWORDS_PL.has(word));
}

function isLookupQueryCompatible(userText, candidateQuery) {
  const userWords = new Set(extractLookupKeywords(userText));
  const candidateWords = new Set(extractLookupKeywords(candidateQuery));
  if (!userWords.size || !candidateWords.size) return false;
  let overlap = 0;
  for (const word of candidateWords) {
    if (userWords.has(word)) overlap += 1;
  }
  const strongNounHit = [...userWords].some((w) => w.length >= 6 && candidateWords.has(w));
  return overlap >= 2 || strongNounHit;
}

async function deriveLookupQueryWithModel(userText, history, abortSignal) {
  const text = normalizeWebQuery(userText);
  if (!text) return "";
  if (isRepeatPrompt(text) && lastChatLookupQuery) return lastChatLookupQuery;

  const recent = Array.isArray(history) ? history.slice(-4).map((msg) => `${msg.role}: ${String(msg.content || "").slice(0, 220)}`).join("\n") : "";
  const promptMessages = [
    {
      role: "system",
      content: [
        "Jestes klasyfikatorem potrzeby web lookup + parserem zapytan.",
        "Najpierw oceń, czy do odpowiedzi POTRZEBNY jest internet.",
        "Jesli internet NIE jest potrzebny, zwroc dokladnie: NONE",
        "Jesli internet jest potrzebny, zwroc zapytanie 2-8 slow kluczowych do wyszukiwarki.",
        "Wyjscie: TYLKO jedna linia tekstu (bez markdown, bez cudzyslowow, bez komentarzy).",
        "Jesli user pyta o konkretna domene, domena musi zostac w zapytaniu.",
        "Jesli user pisze 'jeszcze raz' i brak kontekstu, zwroc NONE.",
      ].join("\n"),
    },
    ...(recent ? [{ role: "user", content: `Kontekst ostatnich wiadomosci:\n${recent}` }] : []),
    { role: "user", content: `Wiadomosc uzytkownika:\n${text}\n\nZapytanie web lookup:` },
  ];
  try {
    const failed = new Set();
    const parsed = await callModelWithRecovery(promptMessages, abortSignal, failed, { plainChat: true, silent: true });
    const raw = String(parsed?.content || "").split(/\r?\n/)[0] || "";
    const cleanedRaw = normalizeWebQuery(raw.replace(/^["'`]+|["'`]+$/g, ""));
    if (/^none$/i.test(cleanedRaw)) return "";
    const cleaned = cleanedRaw;
    if (!cleaned) return "";
    if (!isLookupQueryCompatible(text, cleaned)) {
      const fallback = buildWebLookupCandidates(text)[0] || "";
      return fallback;
    }
    return cleaned.slice(0, 140);
  } catch {
    const fallback = buildWebLookupCandidates(text)[0] || "";
    return fallback;
  }
}

function shouldUseWebLookup(query) {
  const q = String(query || "").trim();
  if (!q || q.length < 6) return false;
  if (/^https?:\/\//i.test(q)) return false;
  return true;
}

function compactWebSnippet(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 260);
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function extractDomainCandidate(text) {
  const match = String(text || "").toLowerCase().match(/\b([a-z0-9-]+\.[a-z]{2,})(?:\/[^\s]*)?\b/);
  if (!match) return "";
  return match[1];
}

async function fetchLivePageSnippet(url) {
  if (!isHttpUrl(url)) return "";
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "EndoCode-Desktop-App" },
      signal: AbortSignal.timeout(CHAT_WEB_PAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return "";
    const html = await response.text();
    const visible = stripHtmlToVisibleText(html);
    return compactWebSnippet(visible).slice(0, CHAT_WEB_PAGE_SNIPPET_CHARS);
  } catch {
    return "";
  }
}

function extractHtmlSignals(html = "") {
  const text = String(html || "");
  if (!text) return [];
  const signals = [];
  const seen = new Set();

  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const title = compactWebSnippet(xmlToVisibleText(titleMatch[1]));
    if (title) {
      signals.push(`title: ${title}`);
      seen.add(`title:${title.toLowerCase()}`);
    }
  }
  const metaDescMatch = text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
  if (metaDescMatch?.[1]) {
    const desc = compactWebSnippet(xmlToVisibleText(metaDescMatch[1]));
    if (desc) {
      const key = `desc:${desc.toLowerCase()}`;
      if (!seen.has(key)) {
        signals.push(`meta-description: ${desc}`);
        seen.add(key);
      }
    }
  }

  const headingRegex = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let h;
  while ((h = headingRegex.exec(text))) {
    const heading = compactWebSnippet(xmlToVisibleText(h[2]));
    if (!heading) continue;
    const key = `h:${heading.toLowerCase()}`;
    if (seen.has(key)) continue;
    signals.push(`heading: ${heading}`);
    seen.add(key);
    if (signals.length >= CHAT_WEB_HTML_SIGNAL_LIMIT) return signals.slice(0, CHAT_WEB_HTML_SIGNAL_LIMIT);
  }

  const paragraphRegex = /<(p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let p;
  while ((p = paragraphRegex.exec(text))) {
    const para = compactWebSnippet(xmlToVisibleText(p[2]));
    if (!para || para.length < 30) continue;
    const key = `p:${para.toLowerCase()}`;
    if (seen.has(key)) continue;
    signals.push(`${p[1] === "li" ? "list" : "paragraph"}: ${para}`);
    seen.add(key);
    if (signals.length >= CHAT_WEB_HTML_SIGNAL_LIMIT) return signals.slice(0, CHAT_WEB_HTML_SIGNAL_LIMIT);
  }

  const keywordRegex = /(właściciel|wlasciciel|owner|kontakt|contact|o nas|about|regulamin|terms|privacy|impressum|krs|nip|regon|sp\.\s*z\s*o\.o|email|e-mail|telefon|tel\.)/ig;
  let match;
  while ((match = keywordRegex.exec(text))) {
    const start = Math.max(0, match.index - 220);
    const end = Math.min(text.length, match.index + 260);
    const chunk = text.slice(start, end);
    const visible = compactWebSnippet(stripHtmlToVisibleText(chunk));
    if (!visible) continue;
    const key = visible.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push(`focus: ${visible}`);
    if (signals.length >= CHAT_WEB_HTML_SIGNAL_LIMIT) break;
  }

  return signals.slice(0, CHAT_WEB_HTML_SIGNAL_LIMIT);
}

async function fetchLivePageInsights(url) {
  if (!isHttpUrl(url)) return { summary: "", signals: [] };
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "EndoCode-Desktop-App" },
      signal: AbortSignal.timeout(CHAT_WEB_PAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return { summary: "", signals: [] };
    const html = await response.text();
    const visible = stripHtmlToVisibleText(html);
    const summary = compactWebSnippet(visible).slice(0, CHAT_WEB_PAGE_SNIPPET_CHARS);
    const signals = extractHtmlSignals(html);
    return { summary, signals };
  } catch {
    return { summary: "", signals: [] };
  }
}

function decodeDuckDuckGoRedirectUrl(rawHref = "") {
  const href = String(rawHref || "").trim();
  if (!href) return "";
  try {
    const absolute = href.startsWith("http") ? href : `https://duckduckgo.com${href}`;
    const u = new URL(absolute);
    const uddg = u.searchParams.get("uddg");
    if (uddg && isHttpUrl(uddg)) return uddg;
    if (isHttpUrl(absolute)) return absolute;
  } catch {
    if (isHttpUrl(href)) return href;
  }
  return "";
}

function extractDuckDuckGoHtmlLinks(html) {
  const text = String(html || "");
  const results = [];
  const seen = new Set();
  const regex = /<a[^>]+class="[^"]*(?:result__a|result-link)[^"]*"[^>]+href="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(text))) {
    const url = decodeDuckDuckGoRedirectUrl(match[1] || "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push(url);
    if (results.length >= CHAT_WEB_SEARCH_RESULT_LIMIT) break;
  }
  return results;
}

async function searchWebLinks(query) {
  const q = normalizeWebQuery(query);
  if (!q) return [];
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "EndoCode-Desktop-App" },
      signal: AbortSignal.timeout(CHAT_WEB_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const html = await response.text();
    return extractDuckDuckGoHtmlLinks(html);
  } catch {
    return [];
  }
}

function collectRelatedTopics(topics = [], out = []) {
  for (const topic of topics) {
    if (!topic) continue;
    if (Array.isArray(topic.Topics)) {
      collectRelatedTopics(topic.Topics, out);
      continue;
    }
    out.push(topic);
  }
  return out;
}

async function getLightWebContext(query, preferredQuery = "", options = {}) {
  const normalized = normalizeWebQuery(query);
  const strictPreferred = options?.strictPreferred === true;
  if (!shouldUseWebLookup(normalized)) {
    return { context: "", sources: [], visitedUrls: [], fromCache: false, skipped: true, query: normalized };
  }
  const cacheKey = normalized.toLowerCase();
  const cached = chatWebLookupCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < CHAT_WEB_LOOKUP_CACHE_TTL_MS) {
    return { ...cached.value, fromCache: true };
  }
  const preferredNormalized = normalizeWebQuery(preferredQuery);
  const candidates = strictPreferred && preferredNormalized
    ? [preferredNormalized]
    : buildWebLookupCandidates(normalized, preferredQuery);
  const domain = extractDomainCandidate(`${preferredQuery} ${normalized}`);
  const domainUrl = domain ? `https://${domain}` : "";
  if (domainUrl) {
    const domainInfo = await fetchLivePageInsights(domainUrl);
    if (domainInfo.summary || (domainInfo.signals && domainInfo.signals.length)) {
      const signalLines = (domainInfo.signals || []).slice(0, CHAT_WEB_HTML_SIGNAL_LIMIT).map((line) => `- [HTML] ${line}`);
      const directContext = `Kontekst z internetu (ultra-light, moze byc niepelny):
- Pipeline: domain-first fetch -> extract visible text + general html digest
- Zapytanie lookup: ${preferredQuery || normalized}
- [LIVE:DOMAIN] ${domainInfo.summary || "Brak krótkiego streszczenia strony"}
${signalLines.join("\n")}`;
      return {
        context: directContext,
        sources: [{ title: `Strona ${domain}`, url: domainUrl, snippet: domainInfo.summary || domainInfo.signals?.[0] || "" }],
        visitedUrls: [domainUrl],
        lookupUrl: "",
        fromCache: false,
        skipped: false,
        query: normalized,
        lookupQuery: preferredQuery || normalized,
      };
    }
  }
  let lastResult = null;
  for (const candidateQuery of candidates) {
    const lookupUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(candidateQuery)}&format=json&no_html=1&skip_disambig=1`;
    try {
      const data = await fetchJson(lookupUrl, { signal: AbortSignal.timeout(CHAT_WEB_LOOKUP_TIMEOUT_MS) });
      const lines = [];
      const sources = [];
      const abstract = compactWebSnippet(data?.AbstractText);
      const heading = compactWebSnippet(data?.Heading);
      if (abstract) {
        lines.push(`- ${heading ? `${heading}: ` : ""}${abstract}`);
        if (data?.AbstractURL) {
          sources.push({
            title: heading || "DuckDuckGo Abstract",
            url: String(data.AbstractURL),
            snippet: abstract,
          });
        }
      }
      const topics = collectRelatedTopics(Array.isArray(data?.RelatedTopics) ? data.RelatedTopics : []);
      for (const topic of topics) {
        if (lines.length >= CHAT_WEB_LOOKUP_MAX_ITEMS) break;
        const text = compactWebSnippet(topic?.Text || topic?.Name || "");
        if (!text) continue;
        lines.push(`- ${text}`);
        if (topic?.FirstURL) {
          sources.push({
            title: compactWebSnippet(topic?.Name || text.split("-")[0] || "Related topic"),
            url: String(topic.FirstURL),
            snippet: text,
          });
        }
      }
      const dedupedSources = [];
      const seen = new Set();
      for (const source of sources) {
        const key = `${source.url}|${source.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedupedSources.push(source);
      }
      let candidateUrls = dedupedSources
        .map((source) => String(source?.url || "").trim())
        .filter((url) => isHttpUrl(url))
        .slice(0, CHAT_WEB_PAGE_FETCH_MAX_SOURCES);
      if (!candidateUrls.length) {
        candidateUrls = (await searchWebLinks(candidateQuery)).slice(0, CHAT_WEB_PAGE_FETCH_MAX_SOURCES);
      }
      const liveInsights = await Promise.all(candidateUrls.map((url) => fetchLivePageInsights(url)));
      for (let i = 0; i < candidateUrls.length; i += 1) {
        const insight = liveInsights[i] || { summary: "", signals: [] };
        const snippet = compactWebSnippet(insight.summary || "");
        const signals = Array.isArray(insight.signals) ? insight.signals.slice(0, 3) : [];
        if (!snippet && !signals.length) continue;
        lines.push(`- [LIVE:${i + 1}] ${snippet || "Brak krótkiego streszczenia."}`);
        for (const signal of signals) lines.push(`- [HTML:${i + 1}] ${signal}`);
        if (!dedupedSources.some((source) => source.url === candidateUrls[i])) {
          dedupedSources.push({
            title: `Web result ${i + 1}`,
            url: candidateUrls[i],
            snippet: snippet || signals[0] || "",
          });
        }
      }

      const result = {
        context: lines.length
          ? `Kontekst z internetu (ultra-light, moze byc niepelny):
- Pipeline: interpret query -> lookup -> fetch live page -> extract visible text + general html digest
- Zapytanie lookup: ${candidateQuery}
${lines.join("\n")}`
          : "",
        sources: dedupedSources,
        visitedUrls: candidateUrls,
        lookupUrl,
        fromCache: false,
        skipped: false,
        query: normalized,
        lookupQuery: candidateQuery,
      };
      lastResult = result;
      if (result.context) {
        chatWebLookupCache.set(cacheKey, { at: Date.now(), value: result });
        return result;
      }
    } catch (error) {
      lastResult = {
        context: "",
        sources: [],
        visitedUrls: [],
        lookupUrl,
        fromCache: false,
        skipped: false,
        query: normalized,
        lookupQuery: candidateQuery,
        error: String(error?.message || error),
      };
    }
  }
  const fallback = lastResult || {
    context: "",
    sources: [],
    visitedUrls: [],
    fromCache: false,
    skipped: false,
    query: normalized,
    lookupQuery: preferredNormalized || normalized,
    error: "",
  };
  chatWebLookupCache.set(cacheKey, { at: Date.now(), value: fallback });
  return fallback;
}

function buildWebLookupFallbackSummary(webLookup, userQuery = "") {
  const sources = Array.isArray(webLookup?.sources) ? webLookup.sources : [];
  const visitedUrls = Array.isArray(webLookup?.visitedUrls) ? webLookup.visitedUrls : [];
  const lines = [];
  for (const source of sources.slice(0, 6)) {
    const title = compactWebSnippet(source?.title || "Zrodlo");
    const snippet = compactWebSnippet(source?.snippet || "");
    const url = String(source?.url || "").trim();
    if (!title && !snippet && !url) continue;
    lines.push(`- ${title || "Zrodlo"}${snippet ? `: ${snippet}` : ""}${url ? `\n  URL: ${url}` : ""}`);
  }
  const uniqueUrls = [...new Set([
    ...sources.map((s) => String(s?.url || "").trim()),
    ...visitedUrls.map((u) => String(u || "").trim()),
  ].filter((url) => isHttpUrl(url)))].slice(0, 8);
  if (!lines.length && !uniqueUrls.length) return "";
  return `Wstepne wyniki z internetu dla zapytania "${compactWebSnippet(userQuery || webLookup?.query || "", 180)}":

${lines.length ? lines.join("\n") : "- Brak snippetow; znaleziono tylko URL-e."}

URL-e do sprawdzenia:
${uniqueUrls.length ? uniqueUrls.map((url) => `- ${url}`).join("\n") : "- Brak URL-i"}

Podsumuj to, co da sie potwierdzic z powyzszych danych. Jesli dane sa niepelne, napisz wprost czego brakuje, ale nadal podaj to co znaleziono.`;
}

function fetchJsonViaHttps(url, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "EndoCode-Desktop-App",
      },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        if (!location) {
          reject(new Error("Przekierowanie bez naglowka Location."));
          return;
        }
        fetchJsonViaHttps(new URL(location, url).toString(), timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        let body = "";
        response.on("data", (chunk) => { body += chunk.toString("utf8"); });
        response.on("end", () => reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 180)}`)));
        return;
      }

      let raw = "";
      response.on("data", (chunk) => { raw += chunk.toString("utf8"); });
      response.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`Niepoprawny JSON odpowiedzi: ${error.message}`));
        }
      });
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error("Timeout pobierania JSON.")));
    request.on("error", reject);
  });
}

async function fetchJsonViaHttpsWithRetry(url, attempts = 3) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fetchJsonViaHttps(url, 45000 + i * 5000);
    } catch (error) {
      lastError = error;
      if (i < attempts) await sleep(600 * i);
    }
  }
  throw lastError || new Error("Nie udalo sie pobrac JSON.");
}

function estimateTokens(msgs) {
  let chars = 0;
  for (const m of msgs) {
    chars += String(m.role || "").length;
    if (typeof m.content === "string") chars += m.content.length;
    else chars += JSON.stringify(m.content || "").length;
  }
  return Math.ceil(chars / 3.5) + msgs.length * 4;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function enforceAlternatingDialogue(messages = []) {
  const out = [];
  for (const msg of messages) {
    const role = String(msg?.role || "user");
    const content = contentToText(msg?.content || "").trim();
    if (!content) continue;
    if (!out.length) {
      out.push({ role, content });
      continue;
    }
    const prev = out[out.length - 1];
    if (prev.role === role) {
      prev.content = `${prev.content}\n\n${content}`;
    } else {
      out.push({ role, content });
    }
  }
  if (out.length && out[0].role !== "user") {
    out[0] = {
      role: "user",
      content: `Kontekst rozmowy:\n${out[0].content}`,
    };
  }
  return out;
}

function buildModelMessages(rawMessages) {
  const messagesIn = Array.isArray(rawMessages) ? rawMessages : [];
  const normalized = messagesIn
    .map((msg) => ({
      role: String(msg?.role || "user"),
      content: contentToText(msg?.content || ""),
    }))
    .filter((msg) => msg.content.trim().length > 0);

  const systemTexts = normalized.filter((msg) => msg.role === "system").map((msg) => msg.content.trim()).filter(Boolean);
  const nonSystem = enforceAlternatingDialogue(normalized.filter((msg) => msg.role !== "system"));
  if (!systemTexts.length) return nonSystem;

  const foldedSystem = `Instrukcja systemowa (nadrzedna):\n${systemTexts.join("\n\n")}`;
  const firstUserIndex = nonSystem.findIndex((msg) => msg.role === "user");
  if (firstUserIndex >= 0) {
    nonSystem[firstUserIndex] = {
      role: "user",
      content: `${foldedSystem}\n\nWiadomosc uzytkownika:\n${nonSystem[firstUserIndex].content}`,
    };
  } else {
    nonSystem.unshift({ role: "user", content: foldedSystem });
  }
  // Keep the original first system message too (for models that support it).
  return [{ role: "system", content: systemTexts[0] }, ...nonSystem];
}

function getContextInfo() {
  const tokens = estimateTokens(messages);
  const model = getModelConfig();
  const modelSettings = getModelSettingsForId(model?.id || selectedModelId);
  const contextTokensLimit = clampContextTokens(modelSettings.contextTokens ?? model?.contextTokens ?? 8192);
  const maxMessages = getActiveMaxMessages();
  const isNearCompaction = messages.length > maxMessages - 4 || tokens > contextTokensLimit * 0.8;
  return {
    messageCount: messages.length,
    maxMessages,
    estimatedTokens: tokens,
    maxTokens: contextTokensLimit,
    willCompactAt: maxMessages,
    isNearCompaction,
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

function getModelSettingsForId(modelId = selectedModelId) {
  const raw = customModelSettingsByModelId?.[modelId] || {};
  return { ...DEFAULT_MODEL_SETTINGS, ...raw };
}

function setModelSettingsForId(modelId, patch = {}) {
  const base = getModelSettingsForId(modelId);
  customModelSettingsByModelId[modelId] = { ...base, ...patch };
}

function resetModelSettingsForId(modelId) {
  customModelSettingsByModelId[modelId] = { ...DEFAULT_MODEL_SETTINGS };
}

function getActiveMaxMessages() {
  const model = getModelConfig();
  const selected = getModelSettingsForId(model?.id || selectedModelId);
  return clampMaxMessages(selected.maxMessages ?? model?.maxMessages ?? 32);
}

function getReasoningProfile() {
  return REASONING_LEVELS[selectedReasoning] || REASONING_LEVELS.medium;
}

function getJsonRepairRetryLimit() {
  if (selectedReasoning === "low") return 0;
  if (selectedReasoning === "medium") return 1;
  return MODEL_JSON_RETRY_LIMIT;
}

function getTransportRetryCount() {
  return selectedReasoning === "low" ? 0 : MODEL_CALL_RETRY_LIMIT;
}

function readInstructionFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 80_000) return "";
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function getAgentPlaybookFiles() {
  const dir = path.join(BIELIK_HOME, "config", "agent-playbooks");
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => path.join(dir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  } catch {
    return [];
  }
}

function loadAgentGuidancePrompt() {
  const files = [];
  const rootAgents = path.join(BIELIK_HOME, "AGENTS.md");
  files.push(rootAgents);
  if (path.resolve(workspaceRoot) !== path.resolve(BIELIK_HOME)) {
    files.push(path.join(workspaceRoot, "AGENTS.md"));
    files.push(path.join(workspaceRoot, "CLAUDE.md"));
  }
  files.push(...getAgentPlaybookFiles());

  let total = "";
  const seen = new Set();
  for (const file of files) {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const text = readInstructionFile(resolved);
    if (!text) continue;
    const rel = path.relative(BIELIK_HOME, resolved).replaceAll("\\", "/") || path.basename(resolved);
    const block = `\n\n--- ${rel} ---\n${text}`;
    if ((total.length + block.length) > AGENT_GUIDANCE_MAX_CHARS) {
      total += `\n\n[Instrukcje skrocone: limit ${AGENT_GUIDANCE_MAX_CHARS} znakow. Czytaj najwazniejsze reguly powyzej.]`;
      break;
    }
    total += block;
  }
  return total.trim();
}

function createSystemPrompt() {
  const model = getModelConfig();
  const reasoning = getReasoningProfile();
  const skillsPrompt = getActiveSkillsPrompt();
  const agentGuidance = loadAgentGuidancePrompt();
  return `${CORE_SYSTEM_PROMPT}

Aktualny model: ${model.displayName || model.id}.
Intensywnosc pracy: ${reasoning.label}.
Instrukcja intensywnosci: ${reasoning.instruction}${skillsPrompt ? `

Dostepne lokalne skills:
${skillsPrompt}

Skills sa lokalnymi instrukcjami pracy, nie zewnetrznymi API. Jesli zadanie pasuje do skilla, uzyj go samodzielnie i zapisz artefakty w workspace.` : ""}${agentGuidance ? `

Instrukcje projektowe i playbooki:
${agentGuidance}` : ""}`;
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
  const previousModelId = selectedModelId;
  failedModelIds.add(selectedModelId);
  const candidates = getFallbackModelCandidates(failedModelIds);
  for (const fallback of candidates) {
    try {
      selectedModelId = fallback.id;
      saveAppSettings();
      if (messages.length) messages[0] = { role: "system", content: createSystemPrompt() };
      resetRuntimeRecoveryState(previousModelId);
      resetRuntimeRecoveryState(fallback.id);
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
  const expectedFile = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const stack = [runtimeDir];
  while (stack.length) {
    const dir = stack.pop();
    if (!pathExists(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (entry.isFile() && entry.name.toLowerCase() === expectedFile) return full;
    }
  }
  return null;
}

function detectInstallTarget() {
  const platform = process.platform;
  const gpuInfo = probeGpuInfo();
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
    return (
      extOk &&
      name.startsWith("llama-") &&
      name.includes(platformToken) &&
      name.includes("x64") &&
      !name.includes("arm") &&
      !name.startsWith("cudart-")
    );
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

async function extractRuntimeArchive(archivePath, extractDir) {
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      const child = spawn("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
      ], { windowsHide: true });
      let stderr = "";
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Rozpakowanie nie powiodlo sie: ${(stderr || stdout || "").trim()}`));
      });
    });
    return;
  }
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    const testTar = spawnSync("tar", ["--version"], { windowsHide: true });
    if (testTar.error) throw new Error("Brak narzędzia 'tar' w systemie.");
    const result = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], { windowsHide: true, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Rozpakowanie tar.gz nie powiodło się: ${(result.stderr || result.stdout || "").trim()}`);
    return;
  }
  if (lower.endsWith(".zip")) {
    const testUnzip = spawnSync("unzip", ["-v"], { windowsHide: true });
    if (testUnzip.error) throw new Error("Brak narzędzia 'unzip' w systemie.");
    const result = spawnSync("unzip", ["-o", archivePath, "-d", extractDir], { windowsHide: true, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Rozpakowanie zip nie powiodło się: ${(result.stderr || result.stdout || "").trim()}`);
    return;
  }
  throw new Error("Nieobsługiwany format archiwum runtime.");
}

async function installLlamaRuntime() {
  const alreadyInstalled = getRuntimeServerExe();
  if (alreadyInstalled) {
    return { ok: true, alreadyInstalled: true, serverExe: alreadyInstalled };
  }

  const target = detectInstallTarget();
  emit("status", { status: "runtime-install", detail: `Wykryty target runtime: ${target.platform} + ${target.gpuVendor}.` });
  emit("status", { status: "runtime-install", detail: `Preferencja backendów: ${target.runtimePreference.join(" -> ")}.` });
  emit("status", { status: "runtime-install", detail: `Sprawdzam najnowsze wydanie llama.cpp dla ${target.platform}...` });
  emit("runtime-install-progress", { phase: "prepare", progress: 5, detail: "Pobieranie metadanych wydania..." });
  const release = await fetchJsonViaHttpsWithRetry("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", 3);

  const runtimeAssets = rankRuntimeAssets(release?.assets || [], target);
  if (!runtimeAssets.length) {
    throw new Error(`Nie znalazlem binarki llama.cpp dla targetu ${target.platform} (${target.runtimePreference.join(", ")}).`);
  }

  const runtimeDir = path.join(BIELIK_HOME, "runtime");
  const tempDir = path.join(runtimeDir, "_install_tmp");
  const extractDir = path.join(tempDir, "extract");
  const releaseTag = String(release?.tag_name || "latest").replace(/[^a-z0-9._-]/gi, "_");
  const finalDir = path.join(runtimeDir, `llama.cpp-${releaseTag}`);

  await fsp.mkdir(tempDir, { recursive: true });
  await fsp.mkdir(extractDir, { recursive: true });

  try {
    let lastError = null;
    for (let i = 0; i < runtimeAssets.length; i += 1) {
      const asset = runtimeAssets[i];
      const archivePath = path.join(tempDir, String(asset.name).replace(/[<>:\"\\|?*]/g, "_"));
      try {
        emit("status", { status: "runtime-install", detail: `Wybrany asset: ${asset.name}` });
        emit("status", { status: "runtime-install", detail: `Pobieram runtime: ${asset.name}` });
        emit("runtime-install-progress", { phase: "download", progress: 8, detail: `Pobieranie ${asset.name}` });
        await downloadFileWithProgress(asset.browser_download_url, archivePath, "Pobieranie runtime llama.cpp", (downloadPct, downloadedBytes, totalBytes) => {
          if (totalBytes > 0) {
            const bounded = Math.max(0, Math.min(100, Number(downloadPct) || 0));
            const uiPct = 8 + Math.round((bounded / 100) * 72);
            emit("runtime-install-progress", { phase: "download", progress: uiPct, detail: `Pobieranie runtime: ${bounded}%` });
          } else {
            const downloadedMb = Number(downloadedBytes || 0) / 1024 / 1024;
            const pseudoPct = Math.min(79, 8 + Math.round(downloadedMb));
            emit("runtime-install-progress", {
              phase: "download",
              progress: pseudoPct,
              detail: `Pobieranie runtime: ${downloadedMb.toFixed(1)} MB`,
            });
          }
        });

        emit("status", { status: "runtime-install", detail: "Rozpakowuje runtime llama.cpp..." });
        emit("runtime-install-progress", { phase: "extract", progress: 84, detail: "Rozpakowywanie archiwum..." });
        await fsp.rm(extractDir, { recursive: true, force: true });
        await fsp.mkdir(extractDir, { recursive: true });
        await extractRuntimeArchive(archivePath, extractDir);

        emit("runtime-install-progress", { phase: "install", progress: 92, detail: "Kopiowanie runtime..." });
        await fsp.rm(finalDir, { recursive: true, force: true });
        await fsp.mkdir(finalDir, { recursive: true });
        await fsp.cp(extractDir, finalDir, { recursive: true, force: true });

        const serverExe = getRuntimeServerExe();
        if (!serverExe) {
          const expectedName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
          throw new Error(`Paczka ${asset.name} nie zawiera ${expectedName}`);
        }
        emit("runtime-install-progress", { phase: "done", progress: 100, detail: "Runtime llama.cpp zainstalowany." });
        emit("status", { status: "runtime-install-complete", detail: "Runtime llama.cpp zainstalowany." });
        return { ok: true, serverExe, asset: asset.name, tag: release?.tag_name || "latest", target };
      } catch (error) {
        lastError = error;
        await fsp.rm(archivePath, { force: true }).catch(() => {});
        if (i < runtimeAssets.length - 1) {
          emit("status", { status: "runtime-install", detail: `Wybrany asset nieudany (${asset.name}). Probuje kolejny...` });
          continue;
        }
      }
    }
    throw lastError || new Error("Nie udalo sie zainstalowac runtime llama.cpp.");
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
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
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(SERVER_READY_PING_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

async function getServerModelId(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(SERVER_READY_PING_TIMEOUT_MS) });
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

  const startupTimeoutMs = getServerStartupTimeoutMs(config, contextTokens);
  const startedAt = Date.now();
  while (Date.now() - startedAt < startupTimeoutMs) {
    if (serverProcess?.exitCode !== null) throw new Error("llama-server zakonczyl prace przed startem API.");
    if (await isServerReady(port)) {
      emit("status", { status: "server-ready", detail: `${config.displayName} gotowy na http://127.0.0.1:${port}` });
      return;
    }
    await sleep(1000);
  }
  throw new Error(`Serwer nie odpowiedzial w ciagu ${Math.round(startupTimeoutMs / 1000)} sekund.`);
}

async function ensureServer(port = DEFAULT_PORT) {
  const config = getModelConfig();
  const modelSettings = getModelSettingsForId(config?.id || selectedModelId);
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

  const contextTokens = clampContextTokens(modelSettings.contextTokens ?? config.contextTokens ?? 8192);
  const configuredGpuLayers = modelSettings.gpuLayers ?? config.gpuLayers ?? 99;
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
    reasoning: modelSettings.reasoning ?? config.reasoning,
    reasoningBudget: modelSettings.reasoningBudget ?? config.reasoningBudget,
    extraServerArgs: Array.isArray(modelSettings.extraServerArgs) ? modelSettings.extraServerArgs : config.extraServerArgs,
  };
  let lastError = null;
  for (let i = 0; i < gpuLayerAttempts.length; i += 1) {
    try {
      await launchServerProcess(runtimeConfig, modelPath, port, contextTokens, gpuLayerAttempts[i]);
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
  const visionPids = getListeningPidsOnPort(VISION_PORT);
  const killedPids = [];
  for (const pid of [...pids, ...visionPids]) {
    if (forceKillPid(pid)) killedPids.push(pid);
  }
  for (let i = 0; i < 30; i += 1) {
    if (!(await isServerReady(DEFAULT_PORT))) break;
    await sleep(200);
  }

  const alive = await isServerReady(DEFAULT_PORT);
  let visionAlive = false;
  try {
    const res = await fetch(`http://127.0.0.1:${VISION_PORT}/health`, { signal: AbortSignal.timeout(1000) });
    visionAlive = res.ok;
  } catch {
    visionAlive = false;
  }
  serverProcess = null;
  serverOwned = false;
  runningModelId = null;
  const stillAlive = [alive ? DEFAULT_PORT : null, visionAlive ? VISION_PORT : null].filter(Boolean);
  const detail = stillAlive.length
    ? `Kill switch wykonany, ale nadal odpowiadaja porty: ${stillAlive.join(", ")}.`
    : `Kill switch zakonczony. Zwolniono porty ${DEFAULT_PORT} i ${VISION_PORT}.`;
  emit("status", { status: "server-killed", detail });
  return { aborted: hadRun, ownedPid, killedPids, port: DEFAULT_PORT, visionPort: VISION_PORT, alive, visionAlive };
}

async function callModel(messages, abortSignal, options = {}, step = null) {
  const plainChat = options.plainChat === true;
  const silent = options.silent === true;
  if (abortSignal?.aborted) throw new Error("Przerwano przez uzytkownika.");
  const abortGuard = createModelAbortGuard(abortSignal);
  const reasoning = getReasoningProfile();
  const model = getModelConfig();
  const modelSettings = getModelSettingsForId(model?.id || selectedModelId);
  const temp = modelSettings.temperature ?? reasoning.temperature;
  const maxTok = modelSettings.maxTokens ?? reasoning.maxTokens;
  const body = {
    model: model.serverModel,
    messages: buildModelMessages(messages),
    temperature: temp,
    max_tokens: maxTok,
    stream: true,
  };
  if (modelSettings.topP != null) body.top_p = modelSettings.topP;
  if (modelSettings.topK != null) body.top_k = modelSettings.topK;
  if (modelSettings.repeatPenalty != null) body.repeat_penalty = modelSettings.repeatPenalty;

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

    let fullContent = "";
    let thinkingContent = "";
    let inThinking = false;
    let repeatedChunkCount = 0;
    let lastChunkNorm = "";
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

          if (delta.reasoning_content) {
            thinkingContent += delta.reasoning_content;
            if (!inThinking) {
              inThinking = true;
              if (!silent) emit("thinking-start", { step });
            }
            if (!silent) emit("thinking-delta", { text: delta.reasoning_content, full: thinkingContent, step });
          }

          if (delta.content) {
            if (inThinking) {
              inThinking = false;
              if (!silent) emit("thinking-end", { full: thinkingContent, step });
            }

            fullContent += delta.content;
            if (plainChat) {
              const chunkNorm = String(delta.content).replace(/\s+/g, " ").trim();
              if (chunkNorm && chunkNorm.length >= 6) {
                if (chunkNorm === lastChunkNorm) repeatedChunkCount += 1;
                else {
                  repeatedChunkCount = 0;
                  lastChunkNorm = chunkNorm;
                }
                if (repeatedChunkCount >= PLAIN_CHAT_REPEAT_CHUNK_LIMIT) {
                  if (!silent) emit("status", {
                    status: "model-action-ready",
                    detail: "Wykryto petle generacji w trybie czatu. Zatrzymuje odpowiedz kontrolowanie.",
                    step,
                  });
                  try { await reader.cancel(); } catch { /* ignore */ }
                  break;
                }
              }
              if (fullContent.length >= PLAIN_CHAT_MAX_CHARS) {
                if (!silent) emit("status", {
                  status: "model-action-ready",
                  detail: `Osiagnieto limit dlugosci odpowiedzi w trybie czatu (${PLAIN_CHAT_MAX_CHARS} znakow).`,
                  step,
                });
                try { await reader.cancel(); } catch { /* ignore */ }
                break;
              }
            }
            if (!plainChat) {
              const firstObject = extractFirstJsonObject(fullContent);
              if (firstObject) {
                if (!silent) emit("content-delta", { text: firstObject, full: firstObject, plainChat, step });
                if (!silent) emit("status", { status: "model-action-ready", detail: "Odebrano pierwsza kompletna akcje JSON; ucinam dalsze generowanie.", step });

                try { await reader.cancel(); } catch { /* ignore */ }
                return { content: firstObject, reasoning: thinkingContent };
              }
            }
            if (!silent) emit("content-delta", { text: delta.content, full: fullContent, plainChat, step });
          }
        } catch {
          // malformed SSE chunk, skip
        }
      }
    }

    if (inThinking) {
      if (!silent) emit("thinking-end", { full: thinkingContent, step });
    }

    return { content: fullContent, reasoning: thinkingContent };
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

function isModelApi500Error(error) {
  const message = String(error?.message || error);
  return /\bModel API 500\b/i.test(message);
}

function isTemplateConversationError(error) {
  const message = String(error?.message || error);
  return /Jinja Exception|Conversation roles must alternate|CallExpression at line/i.test(message);
}

async function callModelWithRecovery(messages, abortSignal, failedModelIds, options = {}, step = null) {
  const retryCount = Math.max(0, Number(getTransportRetryCount() || 0));
  let retriesLeft = retryCount;
  while (true) {
    try {
      const result = await callModel(messages, abortSignal, options, step);
      resetRuntimeRecoveryState();
      return result;
    } catch (error) {
      if (abortSignal?.aborted || !isTransientModelError(error)) throw error;
      if (isTemplateConversationError(error)) {
        throw new Error(
          "Blad formatu rozmowy dla szablonu czatu modelu (Jinja). Zatrzymuje automatyczne restarty runtime, bo to nie jest blad wydajnosci."
        );
      }

      if (isModelApi500Error(error)) {
        try {
          const degraded = await tryApplyRuntimeDegradation(error, step);
          if (degraded) continue;
        } catch (degradeError) {
          emit("status", {
            status: "model-runtime-degrade-failed",
            detail: `Nie udalo sie zastosowac fallbacku runtime: ${textPreview(degradeError?.message || degradeError, 120)}`,
            step,
          });
        }
      }

      if (retriesLeft > 0) {
        const attempt = retryCount - retriesLeft + 1;
        retriesLeft -= 1;
        emit("status", { status: "model-error-retry", detail: `Blad polaczenia: ${textPreview(error.message, 120)}. Ponawiam (${attempt}/${retryCount})...`, step });
        await sleep(2000);
        continue;
      }

      const fallback = failedModelIds ? await switchToFallbackModel(`blad runtime: ${error?.message || "nieznany"}`, failedModelIds) : null;
      if (fallback) continue;
      throw error;
    }
  }
}

function parseJsonCandidate(candidate) {
  try {
    return JSON.parse(candidate);
  } catch (e1) {
    try {
      return JSON.parse(jsonrepair(candidate));
    } catch {
      const msg = String(e1?.message || e1);
      throw new Error(`Model nie zwrocil JSON: ${msg.slice(0, 400)}`);
    }
  }
}

function parseJsonAction(raw) {
  let text = String(raw).trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }
  let lastError = null;
  try {
    return parseJsonCandidate(text);
  } catch (e) {
    lastError = e;
  }
  const firstObject = extractFirstJsonObject(text);
  if (firstObject) {
    try {
      return parseJsonCandidate(firstObject);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error(`Model nie zwrocil JSON: ${text.slice(0, 300)}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function actionSignature(action) {
  return `${action?.tool || ""}:${stableJson(action?.args || {})}`;
}

function getActionRepeatLimit(action) {
  const tool = action?.tool;
  if (["fetch_url", "extract_media", "download_file"].includes(tool)) return 1;
  if (["write_file", "replace_text", "create_pdf", "create_pptx", "create_docx"].includes(tool)) return 1;
  if (["run_powershell"].includes(tool)) return 2;
  return 3;
}

function buildRepeatedActionBlock(action, count) {
  return {
    ok: false,
    error: `Zablokowano zapetlenie: identyczna akcja '${action.tool}' byla juz wykonana ${count} raz(y) w tym zadaniu.`,
    recoveryHint:
      "Nie powtarzaj tej samej akcji. Zmien taktyke: uzyj innego zrodla, innego URL, extract_media na stronie nadrzednej, read_file wynikow, albo zakoncz finalem z tym co wiadomo.",
  };
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

function jsonRepairHintFromError(message) {
  const m = String(message || "").toLowerCase();
  if (/nie tablica|jako tablica|json.*array|^\s*\[/i.test(m) || /^\s*\[/.test(String(message || "").trim())) {
    return "Zwroc jeden obiekt {...}, nie tablice [...]. Jedna odpowiedz = jedno narzedzie lub final.";
  }
  if (/bad escaped|escape|invalid.*escape/i.test(message)) {
    return "Prawdopodobnie niepoprawne sekwencje \\ w stringu (np. Windows path, HTML). Uzyj / w sciezkach; w tresci zamien problematyczne znaki na \\n lub skroc pole content i kontynuuj write_file w trybie append w nastepnym kroku.";
  }
  if (/unexpected end|unterminated|end of json/i.test(message)) {
    return "Prawdopodobnie obciety JSON (limit tokenow). Zwroc TEN SAM krok z krotszymi polami: krotszy URL, albo krotszy fragment write_file + nastepny krok append.";
  }
  return "Sprawdz czy masz jeden obiekt JSON, zamkniete cudzyslowy i nawiasy, poprawne przecinki.";
}

function makeJsonRepairPrompt(error, raw) {
  const errMsg = String(error?.message || error).slice(0, 500);
  return `Poprzednia odpowiedz nie byla poprawnym pojedynczym JSON-em (parser ja odrzucil).
Blad parsera: ${errMsg}
Wskazowka: ${jsonRepairHintFromError(errMsg)}

Twoje zadanie: NAPRAW MINIMALNIE skladnie — zachow ten sam "tool" i intencje "args" co w szkicu, jesli to mozliwe. Nie zmieniaj planu na inne narzedzie, chyba ze naprawa jest niemozliwa.
Jesli naprawa wymaga skrocenia: zwroc poprawny JSON z krotszym args (np. krotszy url albo mniejszy fragment content + dalsza praca w kolejnym kroku przez append).

Odpowiedz WYLACZNIE jednym poprawnym JSON-em zgodnym z kontraktem systemowym — bez Markdown, bez tekstu przed/po, bez tablicy [...] (tylko obiekt {...}).
Jesli odzysk jest niemozliwy:
{"note":"odzysk po bledzie JSON","final":"Nie udalo sie bezpiecznie kontynuowac."}

Odrzucona odpowiedz (fragment):
${String(raw || "").slice(0, 1600)}`;
}

function isPlainAgentJsonObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

/** Modele czesto zwracaja [{...}] zamiast {...} — normalizujemy do jednej akcji na krok. */
function normalizeRootJsonToActionObject(parsed) {
  if (!Array.isArray(parsed)) return parsed;
  if (parsed.length === 1 && isPlainAgentJsonObject(parsed[0])) return parsed[0];
  const first = parsed.find(
    (x) =>
      isPlainAgentJsonObject(x) &&
      ((typeof x.tool === "string" && x.tool.trim() !== "") || (typeof x.final === "string" && x.final.trim() !== "")),
  );
  return first ?? null;
}

function safeDecodeUrlPathSegment(seg) {
  try {
    return decodeURIComponent(String(seg).replace(/\+/g, "%20"));
  } catch {
    return String(seg);
  }
}

/** Zwraca powod lub null — chroni przed „zapetleniem” segmentu sciezki przez model (np. /a/a/a/...). */
function getSuspiciousUrlPathIssue(pathname) {
  const raw = String(pathname ?? "");
  if (!raw || raw === "/") return null;
  const parts = raw.split("/").filter(Boolean).map(safeDecodeUrlPathSegment);
  if (parts.length > 48) return "too_many_segments";
  let run = 1;
  let maxConsecutive = 1;
  for (let i = 1; i < parts.length; i += 1) {
    if (parts[i] === parts[i - 1]) {
      run += 1;
      maxConsecutive = Math.max(maxConsecutive, run);
    } else {
      run = 1;
    }
  }
  if (maxConsecutive >= 4) return "consecutive_dup";
  const freq = new Map();
  for (const p of parts) {
    const key = p.toLowerCase();
    if (!key) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  for (const n of freq.values()) {
    if (n >= 10) return "segment_flood";
  }
  return null;
}

function assertReasonableToolUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) throw new Error("URL jest pusty.");
  if (s.length > MAX_TOOL_URL_LENGTH) {
    throw new Error(
      `URL za dlugi (${s.length} znakow, limit ${MAX_TOOL_URL_LENGTH}). Uzyj krotkiego adresu z paska przegladarki; nie generuj paddingu ani powtorzen w URL.`,
    );
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(s);
  } catch {
    throw new Error("Nieprawidlowy format URL — podaj pelny adres zaczynajacy sie od http:// lub https://.");
  }
  if (!/^https?:$/i.test(parsedUrl.protocol)) {
    throw new Error("Dozwolone sa tylko URL http lub https.");
  }
  const pathIssue = getSuspiciousUrlPathIssue(parsedUrl.pathname || "");
  if (pathIssue === "too_many_segments") {
    throw new Error(
      "URL ma zbyt dluga sciezke (za duzo segmentow) — to zwykle blad generacji modelu. Uzyj krotkiego adresu z dokumentacji lub strony glownej domeny.",
    );
  }
  if (pathIssue === "consecutive_dup" || pathIssue === "segment_flood") {
    throw new Error(
      "URL zawiera wielokrotne powtorzenia tego samego fragmentu sciezki (typowy blad modelu zamiast prawdziwego linku). Podaj krotki URL z paska przegladarki albo strone glowna + extract_media.",
    );
  }
  return s;
}

/**
 * Po skladni JSON: kontrakt albo { final } albo { tool, args }.
 * @returns {{ ok: true, action: object } | { ok: false, error: string }}
 */
function normalizeToolArgsFromRoot(parsed, toolName) {
  if (parsed.args !== undefined || !toolName) return parsed;
  const argKeysByTool = {
    cd: ["path"],
    ls: ["path", "maxEntries"],
    read_file: ["path", "maxBytes"],
    write_file: ["path", "content", "mode"],
    mkdir: ["path"],
    replace_text: ["path", "old", "new", "count"],
    create_pdf: ["path", "title", "markdown", "html", "content"],
    create_pptx: ["path", "title", "markdown", "content"],
    create_docx: ["path", "title", "markdown", "content"],
    run_powershell: ["command", "timeout"],
    fetch_url: ["url", "timeout", "raw"],
    extract_media: ["url", "timeout"],
    download_file: ["url", "path"],
    analyze_image: ["path"],
  };
  const keys = argKeysByTool[toolName] || [];
  const args = {};
  for (const key of keys) {
    if (parsed[key] !== undefined) args[key] = parsed[key];
  }
  return Object.keys(args).length ? { ...parsed, args } : parsed;
}

function validateModelAction(parsed) {
  const normalized = normalizeRootJsonToActionObject(parsed);
  if (normalized === null) {
    if (Array.isArray(parsed)) {
      return {
        ok: false,
        error:
          "Odpowiedz musi byc jednym obiektem JSON {...}, a nie tablica [...]. Jedna wiadomosc = jedna akcja (albo final, albo tool+args).",
      };
    }
  } else {
    parsed = normalized;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Odpowiedz musi byc pojedynczym obiektem JSON (nie tablica)." };
  }
  if ("final" in parsed && parsed.final != null && typeof parsed.final !== "string") {
    parsed = {
      ...parsed,
      final: typeof parsed.final === "object" ? JSON.stringify(parsed.final) : String(parsed.final),
    };
  }
  const hasFinal = typeof parsed.final === "string" && parsed.final.trim() !== "";
  const toolName = typeof parsed.tool === "string" ? parsed.tool.trim() : null;
  if (hasFinal && toolName) {
    return {
      ok: false,
      error: "Nie lacz 'final' z 'tool' w jednej odpowiedzi: albo konczysz (final), albo wywolujesz narzedzie (tool + args).",
    };
  }
  if (hasFinal) {
    return { ok: true, action: { ...parsed, final: parsed.final } };
  }
  if (!toolName) {
    return {
      ok: false,
      error:
        "Brak niepustego pola 'final' i brak pola 'tool' (albo pusty). Dodaj 'final' albo poprawne 'tool' z listy dozwolonych.",
    };
  }
  if (!ALLOWED_TOOLS.has(toolName)) {
    return { ok: false, error: `Niedozwolone lub nieistniejace narzedzie: ${toolName}. Uzyj jednej z nazw: ${allowedToolNamesList()}.` };
  }
  parsed = normalizeToolArgsFromRoot(parsed, toolName);
  if (parsed.args !== undefined && (typeof parsed.args !== "object" || parsed.args === null || Array.isArray(parsed.args))) {
    return { ok: false, error: "Pole 'args' musi byc obiektem JSON (albo pomin, wtedy traktujemy jako {}). " };
  }
  return { ok: true, action: { ...parsed, tool: toolName, args: parsed.args !== undefined ? parsed.args : {} } };
}

function makeActionSchemaRepairPrompt(schemaError, raw) {
  return `Poprzednia odpowiedz miala poprawna skladnie JSON, ale narusza KONTRAKT akcji.
Blad: ${String(schemaError).slice(0, 500)}

Napraw KONTRAKT przy zachowaniu intencji: ten sam "tool" (jesli byl blisko poprawny) albo popraw nazwe na jedna z listy; uzupelnij "final" albo "tool"+"args".

Musisz zwrocic WYLACZNIE jeden obiekt JSON:
- albo koniec pracy: {"note":"...","final":"odpowiedz po polsku"}
- albo narzedzie: {"note":"...","tool":"NAZWA","args":{}}

Dozwolone wartosci "tool" (dokladnie te stringi): ${allowedToolNamesList()}

Nie uzywaj kluczy "name", "function" zamiast "tool". Nie zwracaj samego {"note":"..."} bez "final" ani bez "tool".
Nigdy nie zwracaj JSON jako tablicy [...] — tylko jeden obiekt {...}.
Jesli blad dotyczy zbyt dlugiego write_file w jednym kroku: zwroc krotszy poprawny write_file (overwrite lub append), reszte w nastepnych krokach.

Jesli blad mowi o braku "final" / pustym "final", a uzytkownik pytal o mozliwosci („co potrafisz” itd.): zwroc np.
{"note":"Mozliwosci agenta","final":"Pracuje w sandboxie plikow. Narzedzia: pwd, cd, ls, read_file, write_file, mkdir, replace_text, create_pdf, create_pptx, create_docx, run_powershell, fetch_url, extract_media, download_file, analyze_image. Odpowiadam po polsku; do PPTX/DOCX potrzebny Python z python-pptx / python-docx."}

Jesli nie wiesz co dalej:
{"note":"odzysk","final":"Nie udalo sie zwrocic poprawnej akcji — sprobuj ponownie lub zmien zadanie."}

Odrzucona odpowiedz (fragment):
${String(raw || "").slice(0, 1600)}`;
}

async function getNextActionWithRepair(abortSignal, failedModelIds, step = null) {
  let actionRawReasoning = "";
  let lastError = null;
  const jsonRepairRetryLimit = getJsonRepairRetryLimit();
  while (true) {
    for (let attempt = 0; attempt <= jsonRepairRetryLimit; attempt += 1) {
      if (attempt > 0) {
        emit("status", {
          status: "model-json-retry",
          detail: `Naprawiam odpowiedz JSON / kontrakt (${attempt}/${jsonRepairRetryLimit}).`,
        });
      }
      const { content: raw, reasoning } = await callModelWithRecovery(messages, abortSignal, failedModelIds, {}, step);
      if (reasoning) actionRawReasoning = reasoning;
      emit("model-raw", { raw });
      let parsed;
      try {
        parsed = parseJsonAction(raw);
      } catch (error) {
        lastError = error;
        emit("parse-error", {
          error: error.message || String(error),
          attempt: attempt + 1,
          maxAttempts: jsonRepairRetryLimit + 1,
          raw: textPreview(raw, 1200),
        });
        if (attempt >= jsonRepairRetryLimit) break;
        messages.push({
          role: "assistant",
          content: JSON.stringify({
            note: "Poprzednia odpowiedz modelu byla niepoprawnym JSON-em i zostala odrzucona.",
          }),
        });
        messages.push({ role: "user", content: makeJsonRepairPrompt(error, raw) });
        continue;
      }

      const validated = validateModelAction(parsed);
      if (!validated.ok) {
        lastError = new Error(validated.error);
        emit("parse-error", {
          error: validated.error,
          attempt: attempt + 1,
          maxAttempts: jsonRepairRetryLimit + 1,
          kind: "action-schema",
          raw: textPreview(raw, 1200),
        });
        emit("status", {
          status: "action-schema-retry",
          detail: `Kontrakt akcji: ${textPreview(validated.error, 120)}`,
        });
        if (attempt >= jsonRepairRetryLimit) break;
        messages.push({
          role: "assistant",
          content: JSON.stringify({
            note: "Odpowiedz miala poprawny JSON, ale brakowalo 'final' albo dozwolonego 'tool' z prawidlowym 'args'.",
          }),
        });
        messages.push({ role: "user", content: makeActionSchemaRepairPrompt(validated.error, raw) });
        continue;
      }

      return { action: validated.action, reasoning: actionRawReasoning };

    }
    const fallback = failedModelIds
      ? await switchToFallbackModel(`niepoprawny JSON lub kontrakt: ${lastError?.message || "blad"}`, failedModelIds)
      : null;
    if (!fallback) break;
    messages.push({
      role: "user",
      content: `Aktualny model zostal przelaczony na ${fallback.displayName}. Kontynuuj od ostatniego bezpiecznego kroku i zwroc poprawny JSON.`,
    });
  }
  throw new Error(`Model zwrocil niepoprawny JSON lub kontrakt akcji po kilku probach: ${lastError?.message || "nieznany blad"}`);
}


function textPreview(value, limit = 26000) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated]` : text;
}

function readLogTail(filePath, limit = 5000) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text.length > limit ? text.slice(-limit) : text;
  } catch {
    return "";
  }
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function applyInlineMarkdown(text) {
  return htmlEscape(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
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
      html.push(`<h3>${applyInlineMarkdown(trimmed.slice(4))}</h3>`);
    } else if (trimmed.startsWith("## ")) {
      closeList();
      html.push(`<h2>${applyInlineMarkdown(trimmed.slice(3))}</h2>`);
    } else if (trimmed.startsWith("# ")) {
      closeList();
      html.push(`<h1>${applyInlineMarkdown(trimmed.slice(2))}</h1>`);
    } else if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${applyInlineMarkdown(trimmed.replace(/^[-*]\s+/, ""))}</li>`);
    } else {
      closeList();
      html.push(`<p>${applyInlineMarkdown(trimmed)}</p>`);
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
  let rawContent = "";
  if (args.inputPath) {
    const src = normalizeInsideRoot(args.inputPath);
    rawContent = await fsp.readFile(src, "utf8");
  } else {
    rawContent = args.markdown ?? args.content ?? "";
  }

  const contentHtml = args.html
    ? String(args.html)
    : simpleMarkdownToHtml(rawContent);

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

const OFFICE_MARKDOWN_MAX = 500000;

function getPythonLauncherCandidates() {
  if (process.platform === "win32") {
    return [
      { cmd: "py", pre: ["-3"] },
      { cmd: "py", pre: [] },
      { cmd: "python", pre: [] },
      { cmd: "python3", pre: [] },
    ];
  }
  return [
    { cmd: "python3", pre: [] },
    { cmd: "python", pre: [] },
    { cmd: "py", pre: ["-3"] },
  ];
}

function resolvePythonLauncher() {
  for (const { cmd, pre } of getPythonLauncherCandidates()) {
    const r = spawnSync(cmd, [...pre, "-c", "import sys; sys.exit(0)"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env: process.env,
    });
    if (r.status === 0 && !r.error) return { cmd, pre };
  }
  return null;
}

async function runPythonOfficeHelper(scriptName, payload) {
  const launcher = resolvePythonLauncher();
  if (!launcher) {
    throw new Error(
      "Nie znaleziono Pythona w PATH (probowano py -3, py, python, python3). Zainstaluj Python lub uzyj run_powershell z diagnostyka PATH.",
    );
  }
  const scriptPath = path.join(__dirname, "office", scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Brak skryptu pomocniczego EndoCode: ${scriptName}`);
  }
  await fsp.mkdir(path.join(workspaceRoot, ".tmp"), { recursive: true });
  const jsonPath = path.join(workspaceRoot, ".tmp", `office-${crypto.randomUUID()}.json`);
  await fsp.writeFile(jsonPath, JSON.stringify(payload), "utf8");
  const args = [...launcher.pre, scriptPath, jsonPath];
  const r = spawnSync(launcher.cmd, args, {
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1" },
    cwd: workspaceRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  try {
    await fsp.rm(jsonPath, { force: true });
  } catch {
    /* ignore */
  }
  if (r.error) throw r.error;
  const errBlob = `${r.stderr || ""}\n${r.stdout || ""}`;
  if (r.status === 2 && /pip install python-(pptx|docx)|Brak biblioteki/i.test(errBlob)) {
    throw new Error(errBlob.trim().slice(0, 2000));
  }
  if (r.status !== 0) {
    throw new Error(textPreview(errBlob.trim(), 2000));
  }
}

async function createPptxFile(args) {
  const target = normalizeInsideRoot(args.path || "slides.pptx");
  const outPath = target.toLowerCase().endsWith(".pptx") ? target : `${target}.pptx`;
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const title = String(args.title || path.basename(outPath, ".pptx"));
  let markdown = "";
  if (args.inputPath) {
    const src = normalizeInsideRoot(args.inputPath);
    markdown = await fsp.readFile(src, "utf8");
  } else {
    markdown = String(args.markdown ?? args.content ?? "");
  }
  if (!markdown.trim()) throw new Error("create_pptx wymaga niepustego pola markdown (lub content) lub inputPath.");
  if (markdown.length > OFFICE_MARKDOWN_MAX) {
    throw new Error(`Tresc za dluga (max ${OFFICE_MARKDOWN_MAX} znakow). Podziel zadanie na mniejsze pliki.`);
  }
  await runPythonOfficeHelper("gen_pptx.py", { out: outPath, title, markdown });

  return { path: relativeToRoot(outPath), bytes: fs.statSync(outPath).size, title };
}

async function createDocxFile(args) {
  const target = normalizeInsideRoot(args.path || "document.docx");
  const outPath = target.toLowerCase().endsWith(".docx") ? target : `${target}.docx`;
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const title = String(args.title || path.basename(outPath, ".docx"));
  let markdown = "";
  if (args.inputPath) {
    const src = normalizeInsideRoot(args.inputPath);
    markdown = await fsp.readFile(src, "utf8");
  } else {
    markdown = String(args.markdown ?? args.content ?? "");
  }
  if (!markdown.trim()) throw new Error("create_docx wymaga niepustego pola markdown (lub content) lub inputPath.");
  if (markdown.length > OFFICE_MARKDOWN_MAX) {
    throw new Error(`Tresc za dluga (max ${OFFICE_MARKDOWN_MAX} znakow). Podziel zadanie na mniejsze pliki.`);
  }
  await runPythonOfficeHelper("gen_docx.py", { out: outPath, title, markdown });

  return { path: relativeToRoot(outPath), bytes: fs.statSync(outPath).size, title };
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
  if (/URL za dlugi|Nieprawidlowy format URL|Dozwolone sa tylko URL http/i.test(message)) {
    return "Skroc URL do prawdziwego linku (max ok. 2048 znakow). Wejdz na strone glowna domeny przez fetch_url, potem extract_media aby wyciagnac konkretne href z HTML — nie wklejaj sztucznego dlugiego ciagu.";
  }
  if (
    /wielokrotne powtorzenia|za duzo segmentow|typowy blad generacji modelu/i.test(message) &&
    (tool === "fetch_url" || tool === "extract_media" || tool === "download_file")
  ) {
    return "Model czesto „zapetla” ten sam fragment sciezki, gdy nie zna prawdziwego URL. Nie powtarzaj segmentu — wejdz na krotki adres (strona glowna lub dokumentacja), potem extract_media / prawdziwe href z HTML albo znany endpoint API.";
  }
  if (tool === "fetch_url" && /HTTP Error: 404/.test(message)) {
    return "404: sprawdz dokumentacje uslugi — czesto sa trwalsze sciezki (/last/, /latest/, zasoby archiwalne po dacie) zamiast /today/ lub wygaslych linkow. Wiele API: ?format=json, ?format=csv albo naglowek Accept. Duza odpowiedz: download_file, nie calosc w write_file/JSON.";
  }
  if (tool === "fetch_url" && /timeout|TimeoutError|AbortError|aborted|signal has been aborted|This operation was aborted/i.test(message)) {
    return "Pobranie przekroczylo czas lub zostalo przerwane. W fetch_url/extract_media ustaw timeout (sekundy, 5-60) albo sprawdz URL i polaczenie.";
  }
  if (/(403|404)/.test(message) && (tool === "fetch_url" || tool === "download_file")) {
    return "Błąd 404/403. PRZESTAŃ ZGADYWAĆ linki URL w ciemno! Twoja hipoteza o adresie jest błędna. Natychmiast wróć na stronę główną domeny (lub do Google) i użyj narzędzia extract_media, aby odczytać PRAWDZIWE adresy z kodu HTML lub wyników wyszukiwania. Nie powtarzaj prób na podobnych linkach.";
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
  if (tool === "create_pptx" || tool === "create_docx") {
    if (/pip install python-pptx|pip install python-docx|Brak biblioteki|No module named|ModuleNotFoundError/i.test(message)) {
      const pkg = tool === "create_pptx" ? "python-pptx" : "python-docx";
      return `Brak biblioteki Python. Uruchom (po znalezieniu interpretera): py -3 -m pip install ${pkg} albo python -m pip install ${pkg}. Potem ponow ${tool}.`;
    }
    if (/Nie znaleziono Pythona|Brak skryptu pomocniczego/i.test(message)) {
      return "Najpierw run_powershell: Get-Command python,py,python3 lub where.exe — wybierz dzialajacy interpreter. Zainstaluj Python w PATH, potem pip install.";
    }
  }
  if (tool === "run_powershell") {
    if (/SyntaxError|Unexpected token|Unexpected end|Expected .* after|missing \)|missing \}|unterminated/i.test(message)) {
      return "To blad skladni w konkretnym pliku, nie powod do przepisywania projektu. Odczytaj stack trace/linie, read_file okolicy bledu, popraw minimalny fragment przez replace_text, potem uruchom ten sam check ponownie.";
    }
    if (/ModuleNotFoundError|No module named|ImportError|DLL load failed/i.test(message)) {
      return "Brak modulu Python lub DLL. Najpierw upewnij sie ktory interpreter dziala (Get-Command python,py,python3). Instalacja: czesto py -3 -m pip install NAZWA albo python -m pip install NAZWA. W 'final' podaj dokladna komende i pros o 'kontynuuj' po instalacji.";
    }
    if (
      /is not recognized as an internal or external command|CommandNotFoundException|nie jest rozpoznawany|nie rozpoznano|The term .* is not recognized/i.test(message) &&
      /\bpython\b|\bpy\b|\bpip\b|\bpython3\b/i.test(message)
    ) {
      return "Brak pythona w PATH mimo odswiezenia. Sprobuj uzyc pelnej sciezki, np. '$env:LOCALAPPDATA\\Programs\\Python\\Python312\\python.exe' albo '$env:LOCALAPPDATA\\Programs\\Python\\Python311\\python.exe', sprawdzajac wczesniej przez 'ls $env:LOCALAPPDATA\\Programs\\Python'. Jesli na pewno go nie ma, zainstaluj go.";
    }
    if (/is not recognized as an internal or external command|CommandNotFoundException|nie jest rozpoznawany|nie rozpoznano|The term .* is not recognized/i.test(message)) {
      return "Brak programu w PATH (np. pandoc). W 'final' opisz instalacje (winget/choco) i pros o 'kontynuuj'; nie powtarzaj tej samej komendy w kolko.";
    }
    if (/pip.*not found|No pip|Python was not found|Could not find platform/i.test(message)) {
      return "Python lub pip niedostepny. Jesli dziala launcher: py -3 -m pip --version; instalacja modulu: py -3 -m pip install NAZWA. W 'final' opisz instalacje Pythona w PATH i pros o 'kontynuuj'; tymczasem mozesz przygotowac zrodla w workspace.";
    }
  }
  if (/zablokowane|odrzucil|blocked/i.test(message)) {
    return "Komenda lub akcja zostala zablokowana. Uzyj bezpieczniejszego lokalnego narzedzia, plikow w workspace albo popros o zgode tylko na minimalna potrzebna komende.";
  }
  if (tool === "fetch_url") {
    return "Dla API: ?format=json/csv (jesli dokumentacja to podaje), args.raw:true, albo download_file na pelny plik. Pusta tresc przy HTML: dane moga byc tylko w JS — znajdz oficjalny endpoint JSON/CSV albo extract_media.";
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
    const wrappedCommand = `$env:PATH = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:PATH\n${command}`;
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", wrappedCommand], {
      cwd,
      env: {
        ...process.env,
        TEMP: path.join(workspaceRoot, ".tmp"),
        TMP: path.join(workspaceRoot, ".tmp"),
        AGENT_SANDBOX_ROOT: workspaceRoot,
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

const FETCH_BODY_MAX_CHARS = 25000;
const FETCH_TIMEOUT_MIN_SEC = 5;
const FETCH_TIMEOUT_MAX_SEC = 60;
const FETCH_TIMEOUT_DEFAULT_SEC = 15;

function resolveHttpFetchTimeoutMs(args, defaultSec = FETCH_TIMEOUT_DEFAULT_SEC) {
  let sec = Number(args?.timeout);
  if (!Number.isFinite(sec) || sec <= 0) sec = defaultSec;
  sec = Math.min(FETCH_TIMEOUT_MAX_SEC, Math.max(FETCH_TIMEOUT_MIN_SEC, sec));
  return Math.round(sec * 1000);
}

function shortenContentTypeHeader(ct) {
  if (!ct || typeof ct !== "string") return "";
  return ct.split(";")[0].trim().toLowerCase() || "";
}

function inferDataMimeFromUrl(urlStr) {
  try {
    const pathname = new URL(urlStr).pathname.toLowerCase();
    if (pathname.endsWith(".json")) return "application/json";
    if (pathname.endsWith(".csv")) return "text/csv";
    if (pathname.endsWith(".xml")) return "application/xml";
  } catch {
    return "";
  }
  return "";
}

function shouldUseRawFetchBody(contentTypeLower, urlStr, rawFlag) {
  if (rawFlag === true) return true;
  const pathHint = inferDataMimeFromUrl(urlStr);
  if (pathHint === "text/csv" || pathHint === "application/xml" || pathHint === "application/json") return true;
  const ct = contentTypeLower || "";
  if (/json\b|\+json/.test(ct)) return true;
  if (/csv|tab-separated/.test(ct)) return true;
  if (/xml|\+xml/.test(ct)) return true;
  if (ct === "text/plain" && /\.(csv|xml|json)(\?|#|$)/i.test(urlStr)) return true;
  if ((!ct || ct === "application/octet-stream") && pathHint) return true;
  return false;
}

function stripHtmlToVisibleText(html) {
  return String(html ?? "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateFetchBody(text) {
  const s = String(text ?? "");
  if (s.length <= FETCH_BODY_MAX_CHARS) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, FETCH_BODY_MAX_CHARS)}... (skrocono; pelny plik zapisz przez download_file)`,
    truncated: true,
  };
}

const CHAT_SYSTEM_PROMPT = `Jestes pomocnym asystentem w trybie CZATU (bez akcji narzedziowych, bez plikow w workspace, bez formatu JSON).
Odpowiadaj zwyklym ciaglym tekstem po polsku — zwiezle i rzeczowo.
W tym trybie masz NATYWNY, AUTOMATYCZNY dostep do lekkiego kontekstu internetowego.
Jesli pojawia sie blok "Kontekst z internetu", traktuj go jako aktualne dane pomocnicze i uzyj go w odpowiedzi.
Ten blok moze zawierac pipeline: lookup + fetch live page + extract visible text.
Nie pisz, ze "nie masz internetu" lub "nie mozesz sprawdzic online", bo tryb czatu moze dolaczyc internetowy kontekst automatycznie.
Gdy takiego bloku nie ma, odpowiedz z wiedzy wlasnej i w razie potrzeby zaznacz brak swiezych danych z internetu.
ZASADA ANTYHALUCYNACJI: nie wymyslaj danych firm, kontaktow, adresow, cen, ofert, numerow telefonu ani emaili. Gdy dane sa niepelne, podaj najlepsze dostepne informacje z kontekstu internetowego i jasno zaznacz ograniczenia zamiast odmawiac odpowiedzi.
Jesli podajesz fakty z bloku internetowego, dodaj na koncu sekcje "Zrodla:" i wypisz URL-e z ktorych pochodza dane.
Nigdy nie pisz fikcyjnych zrodel typu "[zrodlo internetowe]" ani "brak zapisanego zrodla".
Nie wymyslaj wynikow narzedzi ani struktur {"tool":...}. Jesli uzytkownik potrzebuje edycji plikow, skryptow lub sandboxa, napisz krotko zeby wylaczyl tryb „Czat” i uzyl zwyklego agenta.`;

function looksLikeWebsiteFactQuestion(text) {
  const q = String(text || "").toLowerCase();
  if (!q) return false;
  const hasDomain = /\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(q);
  const hasFactIntent = /(ofert|uslug|usług|kontakt|telefon|email|mail|adres|firma|strona|oferuj|cennik|dane)/i.test(q);
  return hasDomain || hasFactIntent;
}

function looksLikeFreshFactQuestion(text) {
  const q = String(text || "").toLowerCase();
  if (!q) return false;
  const asksCurrent = /(na dzien|na dzień|dzis|dzisiaj|aktualn|stan na|latest|today|w tym roku)/i.test(q);
  const hasDate = /\b(20\d{2}|[0-3]?\d[./-][01]?\d[./-]20\d{2})\b/i.test(q);
  const topicNeedsFacts = /(cbdc|nbp|bank centralny|inflacj|stopy procentowe|regulacj|prawo|raport|komunikat|decyzj)/i.test(q);
  return (asksCurrent || hasDate) && topicNeedsFacts;
}

function buildForcedLookupQuery(text) {
  const normalized = normalizeWebQuery(text);
  const domain = extractDomainCandidate(normalized);
  if (domain) return `${domain} informacje`;
  const words = normalized
    .replace(/[!?.,;:()[\]{}"'`]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => w.length >= 3)
    .slice(0, 8);
  return words.join(" ").slice(0, 120);
}

function looksLikeNeedsWebInReply(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return false;
  return /(musz[eę]\s*(sprawdzic|sprawdzić|wyszukac|wyszukać)|sprawdze|sprawdz[eę]\s+w\s+internecie|poszukam|zaraz\s+sprawdz[eę]|brak\s+pewnych\s+danych|nie\s+mam\s+aktualnych\s+danych)/i.test(s);
}

function stripSourceSectionsFromHistory(text) {
  const raw = String(text || "");
  if (!raw) return "";
  const lines = raw.split(/\r?\n/);
  const out = [];
  let skipUrlBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^zrodla\s*:|^źródła\s*:|^zweryfikowane zrodla url/i.test(trimmed)) {
      skipUrlBlock = true;
      continue;
    }
    if (skipUrlBlock) {
      if (/^https?:\/\//i.test(trimmed) || /^-\s*https?:\/\//i.test(trimmed) || /^-\s*[a-z0-9.-]+\.[a-z]{2,}/i.test(trimmed)) {
        continue;
      }
      if (!trimmed) continue;
      skipUrlBlock = false;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function executeTool(action) {
  const tool = action.tool;
  if (typeof tool !== "string" || !tool.trim() || !ALLOWED_TOOLS.has(tool)) {
    throw new Error(
      typeof tool !== "string" || !String(tool).trim()
        ? "Brak dozwolonego pola 'tool' w akcji (lub puste). Uzyj dokladnej nazwy narzedzia z listy w promptcie systemowym."
        : `Nieznane narzedzie: ${tool}`,
    );
  }
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
  } else if (tool === "create_pptx") {
    result = await createPptxFile(args);
    emit("file-change", {
      path: result.path,
      action: "create_pptx",
      diff: [],
      before: "",
      after: `PPTX: ${result.title} (${result.bytes} bytes)`,
    });
  } else if (tool === "create_docx") {
    result = await createDocxFile(args);
    emit("file-change", {
      path: result.path,
      action: "create_docx",
      diff: [],
      before: "",
      after: `DOCX: ${result.title} (${result.bytes} bytes)`,
    });
  } else if (tool === "run_powershell") {
    result = await runPowerShell(String(args.command ?? ""), args.timeout);
    const blob = `${result.stderr || ""}\n${result.stdout || ""}`;
    if (
      result.exitCode !== 0 &&
      /not recognized as an internal or external command|CommandNotFoundException|nie jest rozpoznawany|nie rozpoznano|The term '[^']+' is not recognized/i.test(blob) &&
      /\bpython\b|\bpy\b|\bpip\b|\bpython3\b/i.test(blob)
    ) {
      throw new Error(textPreview(blob.trim(), 1500));
    }
  } else if (tool === "fetch_url") {
    const url = assertReasonableToolUrl(args.url);
    const timeoutMs = resolveHttpFetchTimeoutMs(args);
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP Error: ${res.status} (${url.slice(0, 400)})`);
    const text = await res.text();
    const contentTypeHdr = res.headers.get("content-type") || "";
    const contentTypeShort = shortenContentTypeHeader(contentTypeHdr) || inferDataMimeFromUrl(url) || "unknown";
    const useRaw = shouldUseRawFetchBody(contentTypeShort, url, args.raw === true);
    const processed = useRaw ? text : stripHtmlToVisibleText(text);
    const { text: outText, truncated } = truncateFetchBody(processed);
    result = { url, status: res.status, contentType: contentTypeShort, content: outText, truncated };
    if (!String(outText || "").trim()) {
      result.contentHint =
        "Pusta tresc po pobraniu. Jesli to API: sprawdz dokumentacje (?format=json/csv, inne parametry, naglowek Accept) i ewentualnie args.raw:true. Pelny lub bardzo duzy plik: download_file do workspace. Jesli to HTML: tresc moze byc tylko w JS — znajdz oficjalny endpoint z danymi albo extract_media.";
    } else if (url.includes("google.com/search") && (outText.includes("przekierowanie") || outText.includes("trouble accessing"))) {
      result.contentHint = "BLOKADA BOTA: Google Search wykrył robota i zablokował dostęp (strona przekierowania/zgody). NIE PONAWIAJ tego zapytania. Użyj DuckDuckGo (https://duckduckgo.com/html/?q=...) lub wejdź bezpośrednio na stronę docelową.";
    }
  } else if (tool === "extract_media") {
    const url = assertReasonableToolUrl(args.url);
    const timeoutMs = resolveHttpFetchTimeoutMs(args);
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP Error: ${res.status} (${url.slice(0, 400)})`);
    const text = await res.text();
    const imgMatches = [...text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)];
    const urls = imgMatches.map(m => {
      try { return new URL(m[1], url).href; } catch { return m[1]; }
    }).filter(Boolean);
    result = { url, media_count: urls.length, media_urls: [...new Set(urls)].slice(0, 100) };
  } else if (tool === "download_file") {
    const dlUrl = assertReasonableToolUrl(args.url);
    const target = normalizeInsideRoot(args.path);
    const approved = await askApproval({
      title: "Model prosi o pobranie pliku z sieci",
      cwd: relativeToRoot(cwd),
      command: `Pobierz URL: ${dlUrl}\nDo pliku: ${relativeToRoot(target)}`,
    });
    if (!approved) throw new Error("Uzytkownik odrzucil pobieranie pliku.");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const res = await fetch(dlUrl, { redirect: "follow", signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP Error: ${res.status} (${dlUrl.slice(0, 400)})`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target));
    result = { path: relativeToRoot(target), bytes: fs.statSync(target).size };
    emit("file-change", {
      path: relativeToRoot(target),
      action: "download_file",
      diff: [],
      before: "",
      after: `Pobrano ${result.bytes} bajtow z ${dlUrl}`,
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
    throw new Error(`Wewnetrzny blad: brak implementacji narzedzia ${tool}.`);
  }

  emit("tool-result", { tool, ok: true, result });
  return result;
}

async function downloadFileWithProgress(url, targetPath, label, onProgress = null, redirectCount = 0) {
  if (redirectCount > 8) throw new Error(`Za duzo przekierowan podczas pobierania ${label}.`);
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "EndoCode-Desktop-App" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        if (!location) {
          reject(new Error(`Przekierowanie bez Location podczas pobierania ${label}.`));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        downloadFileWithProgress(nextUrl, targetPath, label, onProgress, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Blad HTTP ${res.statusCode} pobierania ${label}`));
        return;
      }

      const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
      let downloadedBytes = 0;
      let lastReportTime = 0;
      const file = fs.createWriteStream(targetPath);

      const abortWith = (error) => {
        try { file.destroy(); } catch { /* ignore */ }
        fs.unlink(targetPath, () => {});
        reject(error);
      };

      res.on("data", (chunk) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastReportTime > 500) {
          const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          if (typeof onProgress === "function") onProgress(pct, downloadedBytes, totalBytes);
          if (totalBytes > 0) emit("status", { status: "downloading", detail: `${label}: ${pct}%` });
          else emit("status", { status: "downloading", detail: `${label}: ${(downloadedBytes / 1024 / 1024).toFixed(1)} MB` });
          lastReportTime = now;
        }
      });

      res.on("error", (err) => abortWith(err));
      file.on("error", (err) => abortWith(err));

      res.pipe(file);
      file.on("finish", () => {
        file.close(() => resolve());
      });
    });

    request.setTimeout(60000, () => {
      request.destroy(new Error(`Timeout pobierania ${label}.`));
    });
    request.on("error", (err) => {
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
      const res = await fetch(`http://127.0.0.1:${VISION_PORT}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch {
      try { forceKillPid(visionServerProcess.pid); } catch {}
      visionServerProcess = null;
    }
  }

  const { textModelPath, mmprojPath } = await ensureVisionSupport();
  const serverExe = getRuntimeServerExe();
  if (!serverExe) throw new Error("Nie znaleziono llama-server.exe dla wizji.");

  try {
    const res = await fetch(`http://127.0.0.1:${VISION_PORT}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return;
  } catch {
    for (const pid of getListeningPidsOnPort(VISION_PORT)) forceKillPid(pid);
  }

  const logDir = path.join(BIELIK_HOME, "logs");
  await fsp.mkdir(logDir, { recursive: true });
  const outLogPath = path.join(logDir, "vision-server.out.log");
  const errLogPath = path.join(logDir, "vision-server.err.log");
  const outLog = fs.openSync(outLogPath, "a");
  const errLog = fs.openSync(errLogPath, "a");

  emit("status", { status: "vision-analysis", detail: "Uruchamiam pomocniczy serwer wizji..." });
  const args = [
    "-m", textModelPath,
    "--mmproj", mmprojPath,
    "--host", "127.0.0.1",
    "--port", String(VISION_PORT),
    "--threads", "4",
    "--ctx-size", "2048",
    "--parallel", "1",
    "--no-jinja",
    "--chat-template", "vicuna",
    "-ngl", "0", // Na razie CPU, żeby nie gryzło się z głównym modelem
  ];

  let child;
  try {
    child = spawn(serverExe, args, {
      cwd: path.dirname(serverExe),
      stdio: ["ignore", outLog, errLog],
      windowsHide: true,
    });
  } finally {
    try { fs.closeSync(outLog); } catch { /* ignore */ }
    try { fs.closeSync(errLog); } catch { /* ignore */ }
  }

  visionServerProcess = child;
  child.on("exit", () => { if (visionServerProcess === child) visionServerProcess = null; });

  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const logTail = readLogTail(errLogPath) || readLogTail(outLogPath);
      throw new Error(`Serwer wizji zakonczyl prace przed startem API (kod ${child.exitCode ?? child.signalCode}).${logTail ? `\n${textPreview(logTail, 1600)}` : ""}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${VISION_PORT}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch {}
    await sleep(1000);
  }
  const logTail = readLogTail(errLogPath) || readLogTail(outLogPath);
  throw new Error(`Serwer wizji nie wystartował w terminie.${logTail ? `\n${textPreview(logTail, 1600)}` : ""}`);
}

async function runVisionSupport(imagePath, prompt) {
  emit("status", { status: "vision-analysis", detail: "Pomocniczy VLM analizuje obraz..." });
  await ensureVisionServer();

  const imageBase64 = fs.readFileSync(imagePath).toString("base64");
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const question = compactWhitespace(prompt) || "Describe this image.";

  const response = await fetch(`http://127.0.0.1:${VISION_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "moondream2",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: question },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      }],
      max_tokens: 512,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(180000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Błąd serwera wizji: ${response.status}${body ? ` ${textPreview(body, 800)}` : ""}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? data?.content ?? "";
  const description = String(content).trim();
  if (!description) throw new Error("Serwer wizji zwrocil pusta odpowiedz.");
  return description;
}

let messages = createInitialMessages();

function compactWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function messageContentToText(content) {
  if (Array.isArray(content)) {
    const textPart = content.find((part) => part && part.type === "text");
    return textPart?.text ? String(textPart.text) : "[Obraz lub zalacznik]";
  }
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content ?? "");
  } catch {
    return String(content ?? "");
  }
}

function summarizeToolResultForCompaction(text) {
  const raw = String(text ?? "");
  if (!raw.startsWith("Wynik narzedzia")) return null;
  const jsonStart = raw.indexOf("\n");
  if (jsonStart < 0) return "Narzędzie: wynik bez danych.";
  try {
    const payload = JSON.parse(raw.slice(jsonStart + 1));
    if (!payload.ok) {
      const error = compactWhitespace(payload.error).slice(0, 220);
      const hint = payload.recoveryHint ? `; obejscie: ${compactWhitespace(payload.recoveryHint).slice(0, 220)}` : "";
      return `Narzędzie: blad: ${error}${hint}`;
    }

    const result = payload.result;
    if (result == null) return "Narzędzie: ok.";
    if (typeof result !== "object" || Array.isArray(result)) {
      return `Narzędzie: ok: ${compactWhitespace(result).slice(0, 260)}`;
    }

    const importantKeys = [
      "path", "cwd", "file", "target", "url", "status", "exitCode",
      "stdout", "stderr", "output", "summary", "message", "bytes", "savedAs",
    ];
    const reduced = {};
    for (const key of importantKeys) {
      if (!(key in result)) continue;
      const value = result[key];
      if (typeof value === "string") reduced[key] = textPreview(value, 360);
      else reduced[key] = value;
    }
    const summary = Object.keys(reduced).length ? reduced : result;
    return `Narzędzie: ok: ${textPreview(JSON.stringify(summary), 520)}`;
  } catch {
    return `Narzędzie: ${compactWhitespace(raw).slice(0, 260)}`;
  }
}

function summarizeMessageForCompaction(msg) {
  const text = messageContentToText(msg.content);
  if (msg.role === "user") {
    const toolSummary = summarizeToolResultForCompaction(text);
    if (toolSummary) return toolSummary;
    if (text.startsWith("[Kompaktowanie kontekstu]")) {
      return `Wczesniejsze podsumowanie: ${compactWhitespace(text).slice(0, 520)}`;
    }
    return `Uzytkownik: ${compactWhitespace(text).slice(0, 320)}`;
  }
  if (msg.role === "assistant") {
    try {
      const parsed = JSON.parse(text);
      const parts = [];
      if (parsed.note) parts.push(`note=${compactWhitespace(parsed.note).slice(0, 160)}`);
      if (parsed.tool) parts.push(`tool=${parsed.tool}`);
      if (parsed.final) parts.push(`final=${compactWhitespace(parsed.final).slice(0, 220)}`);
      return parts.length ? `Agent: ${parts.join("; ")}` : `Agent: ${compactWhitespace(text).slice(0, 220)}`;
    } catch {
      return `Agent: ${compactWhitespace(text).slice(0, 220)}`;
    }
  }
  return `${msg.role || "wiadomosc"}: ${compactWhitespace(text).slice(0, 220)}`;
}

function buildCompactionSummary(oldMessages, contextTokensLimit) {
  const maxSummaryChars = Math.max(1200, Math.min(12000, Math.floor(contextTokensLimit * 0.16 * 3.5)));
  const summaryParts = oldMessages.map(summarizeMessageForCompaction).filter(Boolean);
  if (!summaryParts.length) {
    return { role: "user", content: "[Kompaktowanie kontekstu] Wczesniejsze wiadomosci zostaly usuniete." };
  }
  const visibleParts = summaryParts.slice(-28);
  const omitted = summaryParts.length - visibleParts.length;
  const header = `[Kompaktowanie kontekstu] Podsumowanie wczesniejszej rozmowy (${oldMessages.length} wiadomosci).`;
  const omittedLine = omitted > 0 ? `Pominieto bardzo stare punkty: ${omitted}.` : "";
  const content = [header, omittedLine, ...visibleParts].filter(Boolean).join("\n");
  return { role: "user", content: textPreview(content, maxSummaryChars) };
}

function shrinkRetainedMessageForCompaction(msg, maxChars) {
  const text = messageContentToText(msg.content);
  if (text.length <= maxChars) return msg;
  const toolSummary = summarizeToolResultForCompaction(text);
  if (toolSummary) {
    return {
      role: msg.role,
      content: `Wynik narzedzia zostal skrocony podczas kompaktowania kontekstu:\n${toolSummary}`,
    };
  }
  return {
    role: msg.role,
    content: `${textPreview(text, maxChars)}\n[Skrocono podczas kompaktowania kontekstu.]`,
  };
}

function compactMessages() {
  const tokens = estimateTokens(messages);
  const model = getModelConfig();
  const modelSettings = getModelSettingsForId(model?.id || selectedModelId);
  const contextTokensLimit = clampContextTokens(modelSettings.contextTokens ?? model?.contextTokens ?? 8192);
  const maxMessages = getActiveMaxMessages();
  const overTokens = tokens > contextTokensLimit * 0.85;
  if (messages.length <= maxMessages && !overTokens) return;

  const systemMsg = { role: "system", content: createSystemPrompt() };
  const maxRecentMessages = Math.max(1, maxMessages - 2);
  const minRecentMessages = Math.min(6, maxRecentMessages);
  const targetTokens = Math.max(MIN_CONTEXT_TOKENS, Math.floor(contextTokensLimit * 0.65));
  const placeholderSummary = { role: "user", content: "[Kompaktowanie kontekstu] Podsumowanie poprzednich krokow." };

  let recentStart = messages.length;
  let recentMessages = [];
  for (let i = messages.length - 1; i >= 1; i -= 1) {
    const candidateRecent = [messages[i], ...recentMessages];
    const candidate = [systemMsg, placeholderSummary, ...candidateRecent];
    const underTokenTarget = estimateTokens(candidate) <= targetTokens;
    const underMessageLimit = candidate.length <= maxMessages && candidateRecent.length <= maxRecentMessages;
    const keepMinimum = candidateRecent.length <= minRecentMessages;
    if ((underTokenTarget && underMessageLimit) || keepMinimum) {
      recentMessages = candidateRecent;
      recentStart = i;
    } else {
      break;
    }
  }

  let oldMessages = messages.slice(1, recentStart);
  let summaryMsg = buildCompactionSummary(oldMessages, contextTokensLimit);
  let nextMessages = [systemMsg, summaryMsg, ...recentMessages];

  while ((nextMessages.length > maxMessages || estimateTokens(nextMessages) > targetTokens) && recentMessages.length > minRecentMessages) {
    oldMessages.push(recentMessages.shift());
    summaryMsg = buildCompactionSummary(oldMessages, contextTokensLimit);
    nextMessages = [systemMsg, summaryMsg, ...recentMessages];
  }

  if (estimateTokens(nextMessages) > contextTokensLimit * 0.9) {
    const normalRecentLimit = Math.max(1800, Math.floor(contextTokensLimit * 0.08 * 3.5));
    const latestLimit = Math.max(3000, Math.floor(contextTokensLimit * 0.22 * 3.5));
    recentMessages = recentMessages.map((msg, index) => {
      const limit = index === recentMessages.length - 1 ? latestLimit : normalRecentLimit;
      return shrinkRetainedMessageForCompaction(msg, limit);
    });
    nextMessages = [systemMsg, summaryMsg, ...recentMessages];
  }

  while (estimateTokens(nextMessages) > contextTokensLimit * 0.9 && recentMessages.length > 1) {
    oldMessages.push(recentMessages.shift());
    summaryMsg = buildCompactionSummary(oldMessages, contextTokensLimit);
    nextMessages = [systemMsg, summaryMsg, ...recentMessages];
  }

  if (estimateTokens(nextMessages) > contextTokensLimit * 0.9 && recentMessages.length === 1) {
    const baseTokens = estimateTokens([systemMsg, summaryMsg]);
    const remainingChars = Math.max(1200, Math.floor((contextTokensLimit * 0.84 - baseTokens) * 3.5));
    recentMessages = [shrinkRetainedMessageForCompaction(recentMessages[0], remainingChars)];
    nextMessages = [systemMsg, summaryMsg, ...recentMessages];
  }

  const afterTokens = estimateTokens(nextMessages);
  messages = nextMessages;
  emit("status", {
    status: "context-compacted",
    detail: `Skompaktowano kontekst: ${tokens} -> ${afterTokens} tokenow, ${messages.length} wiadomosci.`,
  });
}

function formatChatFacingError(error, options = {}) {
  const mode = options.mode === "agent" ? "agent" : "chat";
  const modelName = options.modelName || getModelConfig()?.displayName || "model";
  const raw = String(error?.message || error || "").trim();
  const detail = textPreview(raw, 180);
  if (!raw) {
    return mode === "agent"
      ? "Zadanie zatrzymane: wystapil nieznany blad runtime."
      : "Nie udalo sie wygenerowac odpowiedzi. Sprobuj ponownie za chwile.";
  }
  if (/image input is not supported/i.test(raw)) {
    return "Uzywany model jest klasycznym LLM bez obslugi obrazow. Przelacz na model Vision (VLM) albo wyslij samo polecenie tekstowe.";
  }
  if (/llama-server zakonczyl prace przed startem API|Serwer nie odpowiedzial/i.test(raw)) {
    return `Nie udalo sie uruchomic runtime dla ${modelName}. Zmniejsz ustawienia modelu (kontekst/GPU layers) albo wybierz lzejszy model.`;
  }
  if (/Model API 5\d\d/i.test(raw)) {
    return `Runtime modelu ${modelName} zwrocil blad API (${detail}). Sprobuj ponownie lub przelacz na lzejszy model.`;
  }
  if (/timeout|nie wyslal danych/i.test(raw)) {
    return `Model ${modelName} nie odpowiedzial na czas. Sprobuj ponownie albo zmniejsz ustawienia runtime.`;
  }
  if (/Jinja Exception|Conversation roles must alternate/i.test(raw)) {
    return `Model ${modelName} odrzucil format rozmowy (template chat). Sprobuj ponownie po wyczyszczeniu czatu lub zmianie modelu.`;
  }
  if (/Port \d+ zajmuje inny model/i.test(raw)) {
    return `Port runtime jest zajety przez inny model. Uzyj kill switcha serwera i ponow probe.`;
  }
  if (/Nie znaleziono runtime\/llama-server\.exe/i.test(raw)) {
    return "Brakuje runtime llama.cpp. Zainstaluj runtime w ustawieniach aplikacji.";
  }
  if (mode === "agent") return `Zadanie zatrzymane: ${detail}`;
  return `Nie udalo sie wygenerowac odpowiedzi: ${detail}`;
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
    const model = getModelConfig();
    const modelSettings = getModelSettingsForId(model?.id || selectedModelId);
    const failedModelIds = new Set();
    const actionCounts = new Map();
    const reasoningHistory = [];
    const effectiveMaxSteps = modelSettings.maxSteps === 0

      ? 999999
      : (modelSettings.maxSteps ?? reasoning.maxSteps);
    for (let step = 1; step <= effectiveMaxSteps; step += 1) {
      if (signal.aborted) throw new Error("Przerwano przez uzytkownika.");
      compactMessages();
      const stepLabel = effectiveMaxSteps >= 999999 ? `Krok ${step}` : `Krok ${step} / ${effectiveMaxSteps}`;
      emit("status", { status: "model-thinking", detail: `${getModelConfig().displayName} — ${stepLabel}`, step });
      const { action, reasoning } = await getNextActionWithRepair(signal, failedModelIds, step);
      
      // Loop Detection for Reasoning
      if (reasoning && reasoning.trim().length > 10) {
        const lastReasoning = reasoningHistory[reasoningHistory.length - 1];
        if (lastReasoning === reasoning.trim()) {
           throw new Error(`Wykryto petle myslenia modelu (identyczne rozumowanie w kroku ${step-1} i ${step}). Zatrzymuje zadanie, aby uniknac nieskonczonej petli.`);
        }
        reasoningHistory.push(reasoning.trim());
        if (reasoningHistory.length > 3) reasoningHistory.shift();
      }

      if (action.note) emit("note", { note: action.note, step });

      if (action.final) {
        emit("final", { note: action.note || "", text: action.final, step });
        messages.push({ role: "assistant", content: JSON.stringify(action) });
        return { ok: true, final: action.final };
      }



      messages.push({ role: "assistant", content: JSON.stringify(action) });
      if (signal.aborted) throw new Error("Przerwano przez uzytkownika.");
      let toolPayload;
      const signature = actionSignature(action);
      const seenCount = actionCounts.get(signature) || 0;
      const repeatLimit = getActionRepeatLimit(action);
      if (seenCount >= repeatLimit) {
        toolPayload = buildRepeatedActionBlock(action, seenCount);
        emit("tool-result", {
          tool: action.tool,
          ok: false,
          error: toolPayload.error,
          recoveryHint: toolPayload.recoveryHint,
        });
      } else {
        actionCounts.set(signature, seenCount + 1);
        try {
          const result = await executeTool(action);
          toolPayload = { ok: true, result };
        } catch (error) {
          if (signal.aborted) throw new Error("Przerwano przez uzytkownika.");
          const recoveryHint = getToolRecoveryHint(error, action);
          toolPayload = { ok: false, error: error.message, recoveryHint };
          emit("tool-result", { tool: action.tool, ok: false, error: error.message, recoveryHint });
        }
      }

      messages.push({
        role: "user",
        content: `Wynik narzedzia. Kontynuuj albo zakoncz finalem. Jesli ok=false, uwzglednij recoveryHint (jesli jest) i sprobuj innej sciezki — mozesz ponownie uzyc narzedzi, dopoki nie osiagniesz celu lub limitu krokow:\n${JSON.stringify(toolPayload, null, 2)}`,
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
    const message = formatChatFacingError(error, {
      mode: "agent",
      modelName: getModelConfig()?.displayName,
    });
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

async function runSimpleChat(userText) {
  if (runInProgress) throw new Error("Agent juz pracuje.");
  runInProgress = true;
  runAbortController = new AbortController();
  const signal = runAbortController.signal;
  try {
    await validateCurrentWorkspaceRoot();
    await ensureServer(DEFAULT_PORT);
    const chatPayload = typeof userText === "object" && userText !== null
      ? userText
      : { text: userText };
    const text = String(chatPayload?.text ?? "").trim();
    const attachment = chatPayload?.attachment && typeof chatPayload.attachment === "object" ? chatPayload.attachment : null;
    if (!text && !attachment) throw new Error("Pusta wiadomosc.");
    emit("run-start", { text, chatMode: true });
    emit("status", { status: "model-thinking", detail: `${getModelConfig().displayName} — tryb czatu` });
    const isAgentControlMessage = (msg) => {
      const content = String(msg?.content || "");
      if (content.startsWith("Wynik narzedzia.")) return true;
      if (content.startsWith("[Kompaktowanie kontekstu]")) return true;
      if (msg?.role === "assistant") {
        try {
          const parsed = JSON.parse(content);
          if (parsed && typeof parsed === "object" && ("tool" in parsed || "final" in parsed || "note" in parsed)) {
            return true;
          }
        } catch {
          return false;
        }
      }
      return false;
    };
    const history = messages
      .filter((msg) => (msg.role === "user" || msg.role === "assistant") && !isAgentControlMessage(msg))
      .slice(-12)
      .map((msg) => ({
        role: msg.role,
        content: stripSourceSectionsFromHistory(String(msg.content || "")).slice(0, 3000),
      }));
    const chatMessages = [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: text },
    ];
    if (attachment) {
      emit("status", { status: "model-thinking", detail: "Czat: analizuję załączony plik..." });
      const extracted = await extractAttachmentText(attachment);
      if (extracted.ok) {
        chatMessages.splice(1, 0, {
          role: "user",
          content: `Załącznik użytkownika (${extracted.name}, ${Math.max(1, Math.round(extracted.size / 1024))} KB). Wyciągnięty tekst:\n${extracted.text}`,
        });
        emit("status", { status: "model-thinking", detail: `Czat: dołączono tekst z pliku ${extracted.name}.` });
      } else {
        chatMessages.splice(1, 0, {
          role: "user",
          content: `Załącznik użytkownika (${String(attachment.name || "plik")}) nie został odczytany: ${extracted.reason}`,
        });
        emit("status", { status: "model-thinking", detail: `Czat: ${extracted.reason}` });
      }
    }
    const modelLookupQueryRaw = await deriveLookupQueryWithModel(text, history, signal);
    const forceLookup = looksLikeFreshFactQuestion(text);
    const modelLookupQuery = modelLookupQueryRaw || (forceLookup ? buildForcedLookupQuery(text) : "");
    let webLookup = null;
    if (modelLookupQuery) {
      emit("chat-web-lookup", {
        phase: "start",
        query: text,
        lookupQuery: modelLookupQuery,
        detail: modelLookupQueryRaw
          ? "Model zdecydował, że potrzebny jest web lookup."
          : "Wymuszono web lookup dla pytania o świeże fakty/daty.",
      });
      webLookup = await getLightWebContext(text, modelLookupQuery, { strictPreferred: false });
      if (webLookup?.error) {
        emit("chat-web-lookup", {
          phase: "error",
          query: webLookup.query || text,
          lookupUrl: webLookup.lookupUrl || "",
          detail: webLookup.error,
        });
      }
    } else {
      emit("chat-web-lookup", {
        phase: "result",
        used: false,
        fromCache: false,
        lookupUrl: "",
        query: text,
        lookupQuery: "",
        sources: [],
        visitedUrls: [],
        detail: "Model zdecydował, że to pytanie nie wymaga wyszukiwania w internecie.",
      });
    }
    if (webLookup?.context) {
      chatMessages.splice(1, 0, { role: "user", content: `Kontekst z internetu:\n${webLookup.context}` });
      emit("status", { status: "model-thinking", detail: "Czat: dolaczono lekki kontekst internetowy." });
      const sourceUrls = Array.isArray(webLookup.sources)
        ? webLookup.sources.map((source) => String(source?.url || "").trim()).filter(Boolean).slice(0, 6)
        : [];
      if (sourceUrls.length) {
        chatMessages.splice(2, 0, {
          role: "user",
          content: `Zweryfikowane zrodla URL (uzyj tylko ich, nie wymyslaj nowych):\n${sourceUrls.map((url) => `- ${url}`).join("\n")}`,
        });
        chatMessages.splice(3, 0, {
          role: "user",
          content: "W tej odpowiedzi wolno cytowac tylko powyzsze URL-e z biezacej tury. Ignoruj jakiekolwiek starsze zrodla z historii.",
        });
      }
      emit("chat-web-lookup", {
        phase: "result",
        used: true,
        fromCache: Boolean(webLookup.fromCache),
        lookupUrl: webLookup.lookupUrl || "",
        query: webLookup.query || text,
        lookupQuery: webLookup.lookupQuery || modelLookupQuery || "",
        sources: Array.isArray(webLookup.sources) ? webLookup.sources.slice(0, 5) : [],
        visitedUrls: Array.isArray(webLookup.visitedUrls) ? webLookup.visitedUrls.slice(0, 5) : [],
        detail: "Dołączono kontekst internetowy do odpowiedzi.",
      });
      if (webLookup.lookupQuery) lastChatLookupQuery = webLookup.lookupQuery;
    } else if (modelLookupQuery) {
      emit("chat-web-lookup", {
        phase: "result",
        used: false,
        fromCache: Boolean(webLookup?.fromCache),
        lookupUrl: webLookup?.lookupUrl || "",
        query: webLookup?.query || text,
        lookupQuery: webLookup?.lookupQuery || modelLookupQuery || "",
        sources: Array.isArray(webLookup?.sources) ? webLookup.sources.slice(0, 5) : [],
        visitedUrls: Array.isArray(webLookup?.visitedUrls) ? webLookup.visitedUrls.slice(0, 5) : [],
        detail: webLookup?.skipped ? "Pominięto web lookup dla krótkiego/nieadekwatnego zapytania." : "Brak trafnego kontekstu internetowego.",
      });
      const fallbackSummaryPrompt = buildWebLookupFallbackSummary(webLookup, text);
      chatMessages.splice(1, 0, {
        role: "user",
        content: fallbackSummaryPrompt || "Web lookup nie zwrocil pelnego kontekstu. Podaj uczciwie, co udalo sie ustalic i czego nie da sie jeszcze potwierdzic.",
      });
    }
    if (!webLookup?.context && (looksLikeWebsiteFactQuestion(text) || looksLikeFreshFactQuestion(text))) {
      const fallbackSummaryPrompt = buildWebLookupFallbackSummary(webLookup, text);
      if (fallbackSummaryPrompt) {
        chatMessages.splice(1, 0, { role: "user", content: fallbackSummaryPrompt });
      } else {
        chatMessages.splice(1, 0, {
          role: "user",
          content: "Nie zatrzymuj odpowiedzi z powodu braku pelnej weryfikacji. Podaj najlepsze dostepne wyniki i zaznacz ograniczenia.",
        });
      }
    }
    const failedModelIds = new Set();
    let rawReply = await callModelWithRecovery(chatMessages, signal, failedModelIds, { plainChat: true });
    const replySource =
      typeof rawReply === "string"
        ? rawReply
        : rawReply && typeof rawReply === "object" && "content" in rawReply
          ? rawReply.content
          : rawReply;
    let reply = String(replySource ?? "").trim();

    const shouldRetryWithWeb =
      !webLookup?.context &&
      !modelLookupQuery &&
      looksLikeNeedsWebInReply(reply);
    if (shouldRetryWithWeb) {
      const forcedQuery = buildForcedLookupQuery(text);
      if (forcedQuery) {
        emit("chat-web-lookup", {
          phase: "start",
          query: text,
          lookupQuery: forcedQuery,
          detail: "Auto-web: model zasugerował potrzebę sprawdzenia, uruchamiam lookup.",
        });
        const forcedLookup = await getLightWebContext(text, forcedQuery, { strictPreferred: true });
        if (forcedLookup?.context) {
          chatMessages.splice(1, 0, { role: "user", content: `Kontekst z internetu:\n${forcedLookup.context}` });
          const src = Array.isArray(forcedLookup.sources)
            ? forcedLookup.sources.map((source) => String(source?.url || "").trim()).filter(Boolean).slice(0, 6)
            : [];
          if (src.length) {
            chatMessages.splice(2, 0, {
              role: "user",
              content: `Zweryfikowane zrodla URL (uzyj tylko ich, nie wymyslaj nowych):\n${src.map((url) => `- ${url}`).join("\n")}`,
            });
          }
          emit("chat-web-lookup", {
            phase: "result",
            used: true,
            fromCache: Boolean(forcedLookup.fromCache),
            lookupUrl: forcedLookup.lookupUrl || "",
            query: forcedLookup.query || text,
            lookupQuery: forcedLookup.lookupQuery || forcedQuery,
            sources: Array.isArray(forcedLookup.sources) ? forcedLookup.sources.slice(0, 5) : [],
            visitedUrls: Array.isArray(forcedLookup.visitedUrls) ? forcedLookup.visitedUrls.slice(0, 5) : [],
            detail: "Auto-web: dołączono kontekst internetowy i ponawiam odpowiedź.",
          });
          const second = await callModelWithRecovery(chatMessages, signal, failedModelIds, { plainChat: true });
          const secondSource =
            typeof second === "string"
              ? second
              : second && typeof second === "object" && "content" in second
                ? second.content
                : second;
          reply = String(secondSource ?? "").trim();
        } else {
          emit("chat-web-lookup", {
            phase: "result",
            used: false,
            fromCache: Boolean(forcedLookup?.fromCache),
            lookupUrl: forcedLookup?.lookupUrl || "",
            query: forcedLookup?.query || text,
            lookupQuery: forcedLookup?.lookupQuery || forcedQuery,
            sources: Array.isArray(forcedLookup?.sources) ? forcedLookup.sources.slice(0, 5) : [],
            visitedUrls: Array.isArray(forcedLookup?.visitedUrls) ? forcedLookup.visitedUrls.slice(0, 5) : [],
            detail: "Auto-web: brak trafnych danych przy ponownej próbie lookup.",
          });
        }
      }
    }
    messages.push({ role: "user", content: text });
    messages.push({ role: "assistant", content: reply });
    emit("final", { text: reply, chatMode: true });
    return { ok: true, final: reply };
  } catch (error) {
    if (signal.aborted) {
      emit("final", { text: "Przerwano.", chatMode: true });
      return { ok: false, aborted: true };
    }
    const message = formatChatFacingError(error, {
      mode: "chat",
      modelName: getModelConfig()?.displayName,
    });
    emit("final", { text: message, chatMode: true });
    return { ok: false, error: message };
  } finally {
    runInProgress = false;
    runAbortController = null;
    emit("run-end", { chatMode: true });
  }
}

function getState() {
  const modelConfig = getModelConfig();
  const modelSettings = getModelSettingsForId(modelConfig?.id || selectedModelId);
  const serverExe = getRuntimeServerExe();
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
    serverExe,
    runtimeStatus: {
      llamaAvailable: Boolean(serverExe),
      message: serverExe ? "" : "Nie znaleziono runtime/llama-server.exe. Zainstaluj runtime llama.cpp w folderze runtime.",
    },
    port: DEFAULT_PORT,
    customModelSettings: modelSettings,
    customModelSettingsByModelId,
    maxMessages: getActiveMaxMessages(),
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
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isHttpUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  const workspaceResult = await applyWorkspaceRoot(workspaceRoot, { create: false, skipSave: true });
  loadChatHistory();
  const settings = loadAppSettings();
  if (settings.accessLevel) accessLevel = settings.accessLevel;
  if (settings.customModelSettingsByModelId && typeof settings.customModelSettingsByModelId === "object") {
    customModelSettingsByModelId = { ...settings.customModelSettingsByModelId };
  }
  // Legacy migration: global customModelSettings + maxMessages -> selectedModelId entry.
  if (settings.customModelSettings && typeof settings.customModelSettings === "object") {
    const targetModelId = selectedModelId || loadModelCatalog().defaultModelId;
    setModelSettingsForId(targetModelId, {
      ...settings.customModelSettings,
      maxMessages: settings.maxMessages ?? settings.customModelSettings.maxMessages ?? null,
    });
    saveAppSettings();
  }
  for (const [modelId, rawSettings] of Object.entries(customModelSettingsByModelId)) {
    const normalized = { ...DEFAULT_MODEL_SETTINGS, ...(rawSettings || {}) };
    if (normalized.contextTokens != null) normalized.contextTokens = clampContextTokens(normalized.contextTokens);
    if (normalized.maxMessages != null) normalized.maxMessages = clampMaxMessages(normalized.maxMessages);
    customModelSettingsByModelId[modelId] = normalized;
  }
  for (const model of loadModelCatalog().models) {
    if (model.kind !== "local-gguf") continue;
    if (!getModelFileStatus(model).available) continue;
    if (customModelSettingsByModelId[model.id]) continue;
    setModelSettingsForId(model.id, {
      maxMessages: clampMaxMessages(model.maxMessages ?? 32),
      contextTokens: clampContextTokens(model.contextTokens ?? 8192),
      gpuLayers: Number.isFinite(Number(model.gpuLayers)) ? Number(model.gpuLayers) : null,
      threads: Number.isFinite(Number(model.threads)) ? Number(model.threads) : null,
      threadsBatch: Number.isFinite(Number(model.threadsBatch)) ? Number(model.threadsBatch) : null,
      batchSize: Number.isFinite(Number(model.batchSize)) ? Number(model.batchSize) : null,
      ubatchSize: Number.isFinite(Number(model.ubatchSize)) ? Number(model.ubatchSize) : null,
      parallel: Number.isFinite(Number(model.parallel)) ? Number(model.parallel) : null,
      flashAttention: model.flashAttention ?? "on",
      cacheTypeK: model.cacheTypeK ?? "q8_0",
      cacheTypeV: model.cacheTypeV ?? "q8_0",
    });
  }
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
  resetRuntimeRecoveryState(modelId);
  if (!customModelSettingsByModelId[modelId]) {
    setModelSettingsForId(modelId, {
      maxMessages: clampMaxMessages(model.maxMessages ?? 32),
      contextTokens: clampContextTokens(model.contextTokens ?? 8192),
      gpuLayers: Number.isFinite(Number(model.gpuLayers)) ? Number(model.gpuLayers) : null,
      threads: Number.isFinite(Number(model.threads)) ? Number(model.threads) : null,
      threadsBatch: Number.isFinite(Number(model.threadsBatch)) ? Number(model.threadsBatch) : null,
      batchSize: Number.isFinite(Number(model.batchSize)) ? Number(model.batchSize) : null,
      ubatchSize: Number.isFinite(Number(model.ubatchSize)) ? Number(model.ubatchSize) : null,
      parallel: Number.isFinite(Number(model.parallel)) ? Number(model.parallel) : null,
      flashAttention: model.flashAttention ?? "on",
      cacheTypeK: model.cacheTypeK ?? "q8_0",
      cacheTypeV: model.cacheTypeV ?? "q8_0",
    });
  }
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
ipcMain.handle("agent:chat", (_event, text) => runSimpleChat(text));
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
ipcMain.handle("app:system-info", () => {
  const startedAt = Date.now();
  const info = getSystemInfo();
  logPerf("app:system-info", startedAt);
  return info;
});
ipcMain.handle("app:context-info", () => getContextInfo());
ipcMain.handle("app:install-runtime", async () => installLlamaRuntime());
ipcMain.handle("app:set-access-level", (_event, level) => {
  if (level !== "sandbox" && level !== "full") throw new Error(`Nieznany poziom: ${level}`);
  accessLevel = level;
  saveAppSettings();
  emit("status", { status: "access-changed", detail: `Poziom dostepu: ${level === "full" ? "Pelny" : "Sandbox"}` });
  return { accessLevel };
});
ipcMain.handle("app:save-chat", (_event, session) => {
  // Wzbogacamy sesje o pelny techniczny kontekst z pamieci main process
  if (session.id) {
    session.fullContext = messages;
  }
  const idx = chatHistory.findIndex((c) => c.id === session.id);
  if (idx >= 0) chatHistory[idx] = session;
  else chatHistory.unshift(session);
  if (chatHistory.length > 50) chatHistory.length = 50;
  saveChatHistory();
  return chatHistory;
});
ipcMain.handle("app:load-chat-context", (_event, chatId) => {
  const session = chatHistory.find((c) => c.id === chatId);
  if (session && Array.isArray(session.fullContext)) {
    messages = session.fullContext;
    currentChatId = chatId;
    // Odswiezamy system prompt na wypadek zmiany skilli/modelu w miedzyczasie
    refreshSystemPrompt();
    return { ok: true, messageCount: messages.length };
  }
  return { ok: false, reason: "Brak zapisanego kontekstu." };
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

ipcMain.handle("app:list-models", async () => {
  const startedAt = Date.now();
  const catalog = loadModelCatalog();
  const { removedModelIds } = await syncCatalogWithModelFiles(catalog);
  if (removedModelIds.length > 0) {
    emit("status", {
      status: "models-synced",
      detail: `Usunieto z katalogu ${removedModelIds.length} wpisow bez plikow modelu.`,
    });
  }
  const items = catalog.models.map((model) => {
    const status = getModelFileStatus(model);
    const downloadInfo = activeDownloads.get(model.id);
    return {
      ...model,
      available: model.kind === "local-gguf" ? status.available : Boolean(model.enabled),
      fileStatus: {
        ...status,
        downloading: downloadInfo?.state === "queued" || downloadInfo?.state === "downloading",
        progress: downloadInfo?.progress || 0,
        state: downloadInfo?.state || (status.available ? "completed" : "idle"),
        error: downloadInfo?.error || null,
        downloaded: downloadInfo?.downloaded || 0,
        total: downloadInfo?.total || 0,
      },
      selected: model.id === selectedModelId,
    };
  });
  logPerf("app:list-models", startedAt);
  return items;
});

ipcMain.handle("app:download-model", async (_event, modelId) => {
  const catalog = loadModelCatalog();
  const model = catalog.models.find(m => m.id === modelId);
  if (!model) throw new Error("Model nie znaleziony w katalogu.");
  if (model.kind !== "local-gguf") throw new Error("Ten model nie jest lokalnym plikiem GGUF.");

  const dest = path.resolve(BIELIK_HOME, model.file);
  const fileName = path.basename(model.file);
  const sourceRepo = model.source;
  let url = model.downloadUrl;
  if (!url && sourceRepo) {
    if (model.sourceType === "modelscope") {
      url = `https://www.modelscope.cn/models/${sourceRepo}/resolve/master/${encodeURIComponent(fileName)}`;
    } else {
      url = `https://huggingface.co/${sourceRepo}/resolve/main/${encodeURIComponent(fileName)}`;
    }
  }
  if (!url) throw new Error("Brak adresu pobierania dla tego modelu.");

  try {
    await performDownload(url, dest, modelId);
    emit("status", { status: "download-complete", detail: `Pobrano model: ${model.displayName}` });
    return { ok: true };
  } catch (error) {
    throw new Error(`Blad pobierania: ${error.message}`);
  }
});

ipcMain.handle("app:delete-model", async (_event, modelId) => {
  const catalog = loadModelCatalog();
  const model = catalog.models.find(m => m.id === modelId);
  if (!model) throw new Error("Model nie znaleziony.");
  
  const filePath = path.resolve(BIELIK_HOME, model.file);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return { ok: true };
  }
  return { ok: false, error: "Plik nie istnieje." };
});

function parseModelDownloadInput(input) {
  const options = typeof input === "object" && input !== null ? input : { url: input };
  const rawUrl = String(options.url || options.urlOrPath || "").trim();
  if (!rawUrl) throw new Error("Link nie moze byc pusty.");

  let repo = "";
  let file = "";
  let sourceType = "direct";
  let downloadUrl = rawUrl;
  let displayName = options.displayName || "";

  if (!/^https:\/\//i.test(rawUrl)) {
    throw new Error("Wklej bezpośredni link HTTPS do pliku .gguf.");
  }

  const u = new URL(rawUrl);
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const host = u.hostname.toLowerCase();

  if (host === "huggingface.co" || host.endsWith(".huggingface.co")) {
    sourceType = "huggingface";
    const resolveIndex = parts.findIndex((part) => part === "resolve" || part === "blob");
    if (resolveIndex > 1) {
      repo = parts.slice(0, resolveIndex).join("/");
      file = parts.slice(resolveIndex + 2).join("/");
      const revision = parts[resolveIndex + 1] || "main";
      downloadUrl = `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision)}/${file.split("/").map(encodeURIComponent).join("/")}`;
    }
  } else if (host.includes("modelscope.cn") || host.includes("modelscope.ai")) {
    sourceType = "modelscope";
    const modelsIndex = parts.indexOf("models");
    const resolveIndex = parts.findIndex((part) => part === "resolve" || part === "blob");
    if (modelsIndex >= 0 && resolveIndex > modelsIndex + 2) {
      repo = parts.slice(modelsIndex + 1, resolveIndex).join("/");
      file = parts.slice(resolveIndex + 2).join("/");
      const revision = parts[resolveIndex + 1] || "master";
      downloadUrl = `https://www.modelscope.cn/models/${repo}/resolve/${encodeURIComponent(revision)}/${file.split("/").map(encodeURIComponent).join("/")}`;
    }
  } else if (host === "github.com" || host.endsWith(".github.com")) {
    sourceType = "github";
    if (parts.length >= 5 && parts[2] === "releases" && parts[3] === "download") {
      repo = parts.slice(0, 2).join("/");
      file = parts.slice(5).join("/") || parts[4];
    } else {
      const blobIndex = parts.indexOf("blob");
      if (blobIndex === 2 && parts.length > 4) {
        repo = parts.slice(0, 2).join("/");
        const revision = parts[3];
        file = parts.slice(4).join("/");
        downloadUrl = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(revision)}/${file.split("/").map(encodeURIComponent).join("/")}`;
      }
    }
  } else {
    file = parts[parts.length - 1] || "";
    repo = host;
  }

  if (!file) file = parts[parts.length - 1] || "";
  const safeFile = safeModelFileName(file);
  return {
    repo,
    file: safeFile,
    sourceType,
    downloadUrl,
    displayName: displayName || safeFile.replace(/\.gguf$/i, "").replace(/[-_.]/g, " "),
    description: options.description || "",
    expectedBytes: Number(options.expectedBytes || 0),
    contextTokens: options.contextTokens == null ? null : Number(options.contextTokens),
    gpuLayers: options.gpuLayers == null ? null : Number(options.gpuLayers),
    category: options.category || "",
  };
}

ipcMain.handle("app:add-custom-model", async (_event, input) => {
  const catalog = loadModelCatalog();
  const parsed = parseModelDownloadInput(input);
  const { repo, file, sourceType, downloadUrl } = parsed;
  const id = createModelId(file, repo || sourceType);
  if (catalog.models.find(m => m.id === id)) throw new Error("Ten model jest juz w katalogu.");
  const runtimeConfig = createRuntimeModelConfig(parsed);

  const newModel = {
    id,
    displayName: parsed.displayName,
    kind: "local-gguf",
    serverModel: id,
    file: `models/${file}`,
    expectedBytes: parsed.expectedBytes,
    source: repo || sourceType,
    sourceType,
    downloadUrl,
    ...runtimeConfig,
    description: parsed.description || `Własny model dodany z ${sourceType === "direct" ? "bezpośredniego linku" : sourceType}.`,
  };

  catalog.models.push(newModel);
  saveModelCatalog(catalog);
  setModelSettingsForId(id, {
    maxMessages: 32,
    contextTokens: runtimeConfig.contextTokens,
    gpuLayers: runtimeConfig.gpuLayers,
    threads: runtimeConfig.threads,
    threadsBatch: runtimeConfig.threadsBatch,
    batchSize: runtimeConfig.batchSize,
    ubatchSize: runtimeConfig.ubatchSize,
    parallel: runtimeConfig.parallel,
    flashAttention: runtimeConfig.flashAttention,
    cacheTypeK: runtimeConfig.cacheTypeK,
    cacheTypeV: runtimeConfig.cacheTypeV,
  });
  saveAppSettings();
  return { ok: true, model: newModel };
});
ipcMain.handle("app:import-local-model", async (_event, payload) => importLocalModelFromFile(payload));

function buildExternalSourceCard(source, query) {
  const search = encodeURIComponent(query || "gguf");
  const data = {
    modelscope: {
      label: "ModelScope",
      url: `https://www.modelscope.cn/models?name=${search}`,
      description: "ModelScope działa z bezpośrednim linkiem resolve do pliku .gguf albo z repo owner/model.",
    },
    github: {
      label: "GitHub Releases",
      url: `https://github.com/search?q=${search}%20gguf%20release&type=repositories`,
      description: "GitHub działa z linkiem do assetu release .gguf lub raw/blob .gguf.",
    },
  }[source];
  return {
    id: `${source}:external:${query || "gguf"}`,
    source,
    sourceLabel: data.label,
    author: data.label,
    name: `Szukaj w ${data.label}`,
    description: data.description,
    tags: [],
    files: [],
    recommended: false,
    externalOnly: true,
    openUrl: data.url,
    canDownload: false,
  };
}

function filterQuerySuffix(filter) {
  if (filter === "small") return " 3b 7b";
  if (filter === "medium") return " 8b 14b";
  if (filter === "large") return " 30b";
  return "";
}

function createDirectUrlResult(rawUrl, profile) {
  const parsed = parseModelDownloadInput(rawUrl);
  const fit = scoreModelFit({
    name: parsed.displayName,
    fileName: parsed.file,
    sizeBytes: parsed.expectedBytes,
  }, profile);
  return {
    id: `${parsed.sourceType}:${parsed.repo || "direct"}:${parsed.file}`,
    source: parsed.sourceType,
    sourceLabel: parsed.sourceType === "modelscope" ? "ModelScope" : parsed.sourceType === "github" ? "GitHub" : "Direct",
    author: parsed.repo || parsed.sourceType,
    name: parsed.displayName,
    description: `Bezpośredni plik GGUF. ${fit.fitLabel}`,
    tags: [parsed.sourceType],
    recommended: fit.recommended,
    recommendation: fit,
    files: [{
      name: parsed.file,
      sizeBytes: parsed.expectedBytes,
      sizeLabel: formatBytes(parsed.expectedBytes),
      quant: fit.quant,
      fit,
    }],
    fileName: parsed.file,
    expectedBytes: parsed.expectedBytes,
    downloadUrl: parsed.downloadUrl,
    openUrl: parsed.downloadUrl,
    canDownload: true,
  };
}

async function searchHuggingFaceModels(options, profile) {
  const baseQuery = String(options.query || "").trim();
  const hfQuery = `${baseQuery} gguf ${filterQuerySuffix(options.filter)}`.trim() || "gguf";
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(hfQuery)}&filter=gguf&sort=downloads&direction=-1&limit=20&full=true`;
  const data = await fetchJson(url);
  return data.map((model) => {
    const siblings = Array.isArray(model.siblings) ? model.siblings : [];
    const files = siblings
      .filter((file) => String(file.rfilename || "").toLowerCase().endsWith(".gguf"))
      .map((file) => normalizeGgufFile(file, profile, { name: model.id, description: model.description }));
    const best = chooseBestGgufFile(files, profile, { name: model.id, description: model.description });
    if (!best) return null;
    const downloads = Number(model.downloads || 0);
    const likes = Number(model.likes || 0);
    return {
      id: `huggingface:${model.id}`,
      repoId: model.id,
      source: "huggingface",
      sourceLabel: "Hugging Face",
      author: model.author || model.id.split("/")[0],
      name: model.id.split("/").slice(1).join("/") || model.id,
      description: `HF: ${downloads.toLocaleString("pl-PL")} pobrań, ${likes.toLocaleString("pl-PL")} polubień. ${best.fit.fitLabel}.`,
      tags: model.tags || [],
      recommended: best.fit.recommended,
      recommendation: best.fit,
      files,
      fileName: best.name,
      expectedBytes: best.sizeBytes,
      downloadUrl: `https://huggingface.co/${model.id}/resolve/main/${best.name.split("/").map(encodeURIComponent).join("/")}`,
      openUrl: `https://huggingface.co/${model.id}`,
      canDownload: true,
    };
  }).filter(Boolean);
}

function parseModelScopeRepoQuery(query) {
  const value = String(query || "").trim();
  if (!value) return "";
  try {
    const u = new URL(value);
    if (u.hostname.includes("modelscope.cn") || u.hostname.includes("modelscope.ai")) {
      const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const modelsIndex = parts.indexOf("models");
      const stop = parts.findIndex((part, index) => index > modelsIndex && ["resolve", "blob", "files"].includes(part));
      if (modelsIndex >= 0) return parts.slice(modelsIndex + 1, stop > 0 ? stop : undefined).join("/");
    }
  } catch { /* not a URL */ }
  return /^[\w.-]+\/[\w./-]+$/.test(value) ? value : "";
}

async function getModelScopeRepoResult(repoId, profile) {
  const encodedRepo = encodeRepoPath(repoId);
  const detail = await fetchJson(`https://www.modelscope.cn/api/v1/models/${encodedRepo}`);
  const model = detail.Data || {};
  const revision = model.Revision || "master";
  const filesResponse = await fetchJson(`https://www.modelscope.cn/api/v1/models/${encodedRepo}/repo/files?Revision=${encodeURIComponent(revision)}&Recursive=true`);
  const rawFiles = filesResponse?.Data?.Files || [];
  const files = rawFiles
    .filter((file) => String(file.Path || file.Name || "").toLowerCase().endsWith(".gguf"))
    .map((file) => normalizeGgufFile(file, profile, { name: repoId, description: model.Description || model.ChineseName }));
  const best = chooseBestGgufFile(files, profile, { name: repoId, description: model.Description || model.ChineseName });
  if (!best) throw new Error("Nie znaleziono pliku .gguf w repozytorium ModelScope.");
  return {
    id: `modelscope:${repoId}`,
    repoId,
    source: "modelscope",
    sourceLabel: "ModelScope",
    author: repoId.split("/")[0],
    name: model.Name || repoId.split("/").slice(1).join("/"),
    description: `ModelScope: ${(model.Downloads || 0).toLocaleString("pl-PL")} pobrań. ${best.fit.fitLabel}.`,
    tags: model.Tags || model.Libraries || [],
    recommended: best.fit.recommended,
    recommendation: best.fit,
    files,
    fileName: best.name,
    expectedBytes: best.sizeBytes,
    downloadUrl: `https://www.modelscope.cn/models/${repoId}/resolve/${encodeURIComponent(revision)}/${best.name.split("/").map(encodeURIComponent).join("/")}`,
    openUrl: `https://www.modelscope.cn/models/${repoId}`,
    canDownload: true,
  };
}

async function searchModelSources(options = {}) {
  const source = options.source || "all";
  const query = String(options.query || "").trim().toLowerCase();
  const filter = options.filter || "all";
  const profile = getHardwareModelProfile();
  const results = [];

  // 1. Search Presets (the "gotowe linki")
  if (source === "all" || source === "presets" || source === "huggingface") {
    const presets = loadModelPresets();
    const filteredPresets = presets.filter(p => {
      const text = `${p.displayName} ${p.id} ${p.description} ${p.category} ${p.source}`.toLowerCase();
      const matchesQuery = !query || text.includes(query);
      const matchesFilter = filter === "all" || p.category === filter;
      return matchesQuery && matchesFilter;
    });

    results.push(...filteredPresets.map(p => {
      const fit = scoreModelFit({
        name: p.displayName,
        fileName: p.file || p.fileName,
        sizeBytes: p.expectedBytes
      }, profile);
      return {
        id: `preset:${p.id}`,
        repoId: p.source,
        source: "presets",
        sourceLabel: "Polecane",
        author: p.author || "EndoCode",
        name: p.displayName,
        description: p.description || `Model z Twojej listy polecanych. ${fit.fitLabel}`,
        tags: [p.category, ...(p.tags || [])],
        recommended: fit.recommended,
        recommendation: fit,
        files: [],
        fileName: p.file || p.fileName,
        expectedBytes: p.expectedBytes,
        downloadUrl: p.downloadUrl || (p.source ? `https://huggingface.co/${p.source}/resolve/main/${p.file || p.fileName}` : ""),
        openUrl: p.source ? `https://huggingface.co/${p.source}` : "",
        canDownload: true,
        hardwareProfile: profile.target
      };
    }));
  }

  // 2. Search External
  if (source === "all" || source === "huggingface") {
    try {
      const hfResults = await searchHuggingFaceModels(options, profile);
      // Avoid duplicates with presets
      const presetRepos = new Set(results.map(r => r.repoId));
      results.push(...hfResults.filter(r => !presetRepos.has(r.repoId)));
    } catch (e) {
      console.error("HF Search error:", e);
    }
  }

  if (query && (source === "all" || source === "modelscope")) {
    const repoId = parseModelScopeRepoQuery(query);
    if (repoId) {
      try {
        results.push(await getModelScopeRepoResult(repoId, profile));
      } catch (error) {
        results.push({ ...buildExternalSourceCard("modelscope", query), description: `Błąd ModelScope: ${error.message}` });
      }
    } else if (source === "modelscope") {
      results.push(buildExternalSourceCard("modelscope", query));
    }
  }

  if (query && (source === "all" || source === "github")) {
    results.push(buildExternalSourceCard("github", query));
  }

  // Sort: Presets first, then by recommendation score
  return results
    .sort((a, b) => {
      if (a.source === "presets" && b.source !== "presets") return -1;
      if (a.source !== "presets" && b.source === "presets") return 1;
      return (Number(b.recommended) - Number(a.recommended)) || ((b.recommendation?.score || 0) - (a.recommendation?.score || 0));
    })
    .slice(0, 30);
}

ipcMain.handle("app:search-models", async (_event, options) => searchModelSources(options));
ipcMain.handle("app:search-hf-models", async (_event, options) => searchModelSources({ ...(options || {}), source: "huggingface" }));
ipcMain.handle("app:open-external", async (_event, url) => {
  const target = String(url || "");
  if (!/^https?:\/\//i.test(target)) throw new Error("Niepoprawny adres URL.");
  await shell.openExternal(target);
  return { ok: true };
});

async function performDownload(url, dest, modelId) {
  if (activeDownloads.get(modelId)?.state === "downloading") throw new Error("Pobieranie juz trwa.");
  
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const tempDest = dest + ".downloading";
  const file = fs.createWriteStream(tempDest);
  
  activeDownloads.set(modelId, { state: "queued", progress: 0, downloaded: 0, total: 0, error: null });
  emit("agent:event", { type: "model-download-state", modelId, state: "queued", progress: 0, downloaded: 0, total: 0 });

  return new Promise((resolve, reject) => {
    function startRequest(requestUrl) {
      const request = https.get(requestUrl, { headers: { "User-Agent": "EndoCode-Desktop-App" } }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location;
          if (!location) {
            reject(new Error("Przekierowanie bez nagłówka Location."));
            return;
          }
          startRequest(new URL(location, requestUrl).toString());
          return;
        }

        if (response.statusCode !== 200) {
          fs.unlink(tempDest, () => {});
          activeDownloads.delete(modelId);
          reject(new Error(`Serwer zwrocil blad ${response.statusCode}`));
          return;
        }

        const total = parseInt(response.headers["content-length"], 10) || 0;
        let downloaded = 0;
        let lastPercent = -1;
        activeDownloads.set(modelId, { state: "downloading", progress: 0, downloaded: 0, total, error: null });
        emit("agent:event", { type: "model-download-state", modelId, state: "downloading", progress: 0, downloaded: 0, total });

        response.on("data", (chunk) => {
          downloaded += chunk.length;
          const progress = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          if (progress !== lastPercent) {
            lastPercent = progress;
            activeDownloads.set(modelId, { state: "downloading", progress, downloaded, total, error: null });
            emit("agent:event", { type: "model-download-progress", modelId, progress, downloaded, total });
          }
        });

        response.pipe(file);

        file.on("finish", () => {
          file.close();
          try {
             if (fs.existsSync(dest)) fs.unlinkSync(dest);
             fs.renameSync(tempDest, dest);
             activeDownloads.delete(modelId);
             emit("agent:event", { type: "model-download-state", modelId, state: "completed", progress: 100, downloaded, total });
              resolve();
           } catch (e) {
              activeDownloads.set(modelId, { state: "failed", progress: 0, downloaded: 0, total: 0, error: String(e?.message || e) });
              emit("agent:event", { type: "model-download-state", modelId, state: "failed", progress: 0, downloaded: 0, total: 0, error: String(e?.message || e) });
              reject(e);
           }
        });
      });

      request.on("error", (err) => {
        fs.unlink(tempDest, () => {});
        activeDownloads.set(modelId, { state: "failed", progress: 0, downloaded: 0, total: 0, error: String(err?.message || err) });
        emit("agent:event", { type: "model-download-state", modelId, state: "failed", progress: 0, downloaded: 0, total: 0, error: String(err?.message || err) });
        reject(err);
      });
    }
    
    startRequest(url);
  });
}

const MODEL_RUNTIME_WHITELIST = new Set([
  "temperature", "maxTokens", "maxSteps", "topP", "topK", "repeatPenalty",
  "contextTokens", "gpuLayers", "maxMessages", "threads", "threadsBatch",
  "batchSize", "ubatchSize", "parallel", "flashAttention", "cacheTypeK",
  "cacheTypeV", "reasoning", "reasoningBudget", "extraServerArgs",
]);

function getEffectiveSettingsForModel(modelId) {
  const model = loadModelCatalog().models.find((entry) => entry.id === modelId) || getModelConfig();
  const selected = getModelSettingsForId(model?.id || modelId);
  return {
    temperature: selected.temperature ?? getReasoningProfile().temperature,
    maxTokens: selected.maxTokens ?? getReasoningProfile().maxTokens,
    maxSteps: selected.maxSteps ?? getReasoningProfile().maxSteps,
    topP: selected.topP ?? null,
    topK: selected.topK ?? null,
    repeatPenalty: selected.repeatPenalty ?? null,
    contextTokens: selected.contextTokens ?? model?.contextTokens ?? 8192,
    gpuLayers: selected.gpuLayers ?? model?.gpuLayers ?? 99,
    maxMessages: selected.maxMessages ?? model?.maxMessages ?? 32,
    threads: selected.threads ?? model?.threads ?? null,
    threadsBatch: selected.threadsBatch ?? model?.threadsBatch ?? null,
    batchSize: selected.batchSize ?? model?.batchSize ?? null,
    ubatchSize: selected.ubatchSize ?? model?.ubatchSize ?? null,
    parallel: selected.parallel ?? model?.parallel ?? null,
    flashAttention: selected.flashAttention ?? model?.flashAttention ?? null,
    cacheTypeK: selected.cacheTypeK ?? model?.cacheTypeK ?? null,
    cacheTypeV: selected.cacheTypeV ?? model?.cacheTypeV ?? null,
    reasoning: selected.reasoning ?? model?.reasoning ?? null,
    reasoningBudget: selected.reasoningBudget ?? model?.reasoningBudget ?? null,
    extraServerArgs: selected.extraServerArgs ?? model?.extraServerArgs ?? [],
  };
}

function sanitizeSettingsPatch(rawSettings = {}) {
  const patch = {};
  for (const [key, value] of Object.entries(rawSettings || {})) {
    if (!MODEL_RUNTIME_WHITELIST.has(key)) continue;
    patch[key] = value;
  }
  if (patch.contextTokens != null) patch.contextTokens = clampContextTokens(patch.contextTokens);
  if (patch.maxMessages != null) patch.maxMessages = clampMaxMessages(patch.maxMessages);
  if (patch.gpuLayers != null) patch.gpuLayers = clampRuntimeNumber(patch.gpuLayers, 0, 99);
  if (patch.threads != null) patch.threads = clampRuntimeNumber(patch.threads, SAFE_RUNTIME_LIMITS.threadsMin, SAFE_RUNTIME_LIMITS.threadsMax);
  if (patch.threadsBatch != null) patch.threadsBatch = clampRuntimeNumber(patch.threadsBatch, SAFE_RUNTIME_LIMITS.threadsBatchMin, SAFE_RUNTIME_LIMITS.threadsBatchMax);
  if (patch.batchSize != null) patch.batchSize = clampRuntimeNumber(patch.batchSize, SAFE_RUNTIME_LIMITS.batchMin, SAFE_RUNTIME_LIMITS.batchMax);
  if (patch.ubatchSize != null) patch.ubatchSize = clampRuntimeNumber(patch.ubatchSize, SAFE_RUNTIME_LIMITS.ubatchMin, SAFE_RUNTIME_LIMITS.ubatchMax);
  if (patch.parallel != null) patch.parallel = clampRuntimeNumber(patch.parallel, SAFE_RUNTIME_LIMITS.parallelMin, SAFE_RUNTIME_LIMITS.parallelMax);
  return patch;
}

ipcMain.handle("app:get-model-settings", (_event, modelId) => {
  const targetModelId = String(modelId || selectedModelId);
  const model = loadModelCatalog().models.find((entry) => entry.id === targetModelId);
  if (!model) throw new Error(`Nieznany model: ${targetModelId}`);
  return {
    modelId: targetModelId,
    modelName: model.displayName,
    ...getModelSettingsForId(targetModelId),
    _effective: getEffectiveSettingsForModel(targetModelId),
  };
});

ipcMain.handle("app:set-model-settings", async (_event, payload) => {
  const targetModelId = String(payload?.modelId || selectedModelId);
  const model = loadModelCatalog().models.find((entry) => entry.id === targetModelId);
  if (!model) throw new Error(`Nieznany model: ${targetModelId}`);
  const settings = sanitizeSettingsPatch(payload?.settings || payload || {});
  setModelSettingsForId(targetModelId, settings);
  resetRuntimeRecoveryState(targetModelId);
  saveAppSettings();
  const requiresRestart = ["contextTokens", "gpuLayers", "threads", "threadsBatch", "batchSize", "ubatchSize", "parallel", "flashAttention", "cacheTypeK", "cacheTypeV", "reasoning", "reasoningBudget", "extraServerArgs"]
    .some((key) => settings[key] !== undefined);
  if (requiresRestart && serverOwned && targetModelId === selectedModelId) {
    await stopOwnedServer();
    emit("status", { status: "settings-changed", detail: "Zmieniono ustawienia modelu — runtime zrestartuje się przy następnym zapytaniu." });
  }
  return { ok: true, modelId: targetModelId, settings: getModelSettingsForId(targetModelId) };
});

ipcMain.handle("app:reset-model-settings", async (_event, modelId) => {
  const targetModelId = String(modelId || selectedModelId);
  resetModelSettingsForId(targetModelId);
  resetRuntimeRecoveryState(targetModelId);
  saveAppSettings();
  if (serverOwned && targetModelId === selectedModelId) await stopOwnedServer();
  return { ok: true, modelId: targetModelId, settings: getModelSettingsForId(targetModelId) };
});

ipcMain.handle("app:get-model-raw-config", (_event, modelId) => {
  const targetModelId = String(modelId || selectedModelId);
  const settings = getModelSettingsForId(targetModelId);
  const raw = {};
  for (const key of MODEL_RUNTIME_WHITELIST) raw[key] = settings[key];
  return { modelId: targetModelId, rawJson: JSON.stringify(raw, null, 2) };
});

ipcMain.handle("app:set-model-raw-config", async (_event, payload) => {
  const targetModelId = String(payload?.modelId || selectedModelId);
  let parsed;
  try {
    parsed = JSON.parse(String(payload?.rawJson || "{}"));
  } catch {
    throw new Error("Niepoprawny JSON konfiguracji modelu.");
  }
  const patch = sanitizeSettingsPatch(parsed);
  setModelSettingsForId(targetModelId, patch);
  resetRuntimeRecoveryState(targetModelId);
  saveAppSettings();
  if (serverOwned && targetModelId === selectedModelId) await stopOwnedServer();
  return { ok: true, modelId: targetModelId, settings: getModelSettingsForId(targetModelId) };
});
