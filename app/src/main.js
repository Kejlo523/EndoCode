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
const JSZip = require("jszip");
const { createTelemetryMonitor } = require("./main/telemetry");
const { createRuntimeManifestStore } = require("./main/runtime-core/runtime-manifest");
const {
  detectInstallTarget: detectInstallTargetByPolicy,
  rankRuntimeAssets: rankRuntimeAssetsByPolicy,
  inferBackendFromAssetName,
  inferBackendFromLogs,
} = require("./main/runtime-core/backend-policy");
const { createBaselineMetrics } = require("./main/telemetry/baseline-metrics");
const { createInstructionPolicyEngine } = require("./main/prompt/instruction-policy");
const {
  ALLOWED_TOOLS,
  allowedToolNamesList,
  buildToolsPromptBlock,
} = require("./main/agent/command-contract");
const { createRuntimeEngine } = require("./main/runtime-core/runtime-engine");
const { createSessionMemory } = require("./main/agent/session-memory");
const { createAgentPlanner } = require("./main/agent/agent-planner");
const { createToolExecutor } = require("./main/agent/tool-executor");
const { createTurnOrchestrator } = require("./main/agent/turn-orchestrator");
const { classifyIntent, validateAction, buildMachineRepairPrompt } = require("./main/agent/action-validator");
const { registerAgentIpcHandlers } = require("./main/agent/ipc-compat");

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
const CHAT_WEB_LOOKUP_TIMEOUT_MS = 3000;
const CHAT_WEB_LOOKUP_RETRY_TIMEOUT_MS = 6000;
const CHAT_WEB_LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;
const CHAT_WEB_LOOKUP_MAX_ITEMS = 6;
const CHAT_WEB_PAGE_FETCH_TIMEOUT_MS = 2500;
const CHAT_WEB_PAGE_FETCH_RETRY_TIMEOUT_MS = 5000;
const CHAT_WEB_PAGE_FETCH_MAX_SOURCES = 8;
const CHAT_WEB_PAGE_SNIPPET_CHARS = 320;
const CHAT_WEB_SEARCH_RESULT_LIMIT = 12;
const CHAT_WEB_HTML_SIGNAL_LIMIT = 10;
const CHAT_WEB_SOURCE_GOOD_SNIPPET_CHARS = 120;
const CHAT_WEB_SOURCE_WEAK_SNIPPET_CHARS = 45;
const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_SEARCH_API_KEY = String(process.env.BRAVE_SEARCH_API_KEY || "").trim();
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

const MIN_CONTEXT_TOKENS = 1024;
const ABSOLUTE_MAX_CONTEXT_TOKENS = 262_144;
const MIN_RESPONSE_TOKENS = 256;
const ABSOLUTE_MAX_RESPONSE_TOKENS = 65_536;
/** Ile wiadomości w historii agenta przed kompaktowaniem (górny limit suwaka). */
const MAX_CHAT_MESSAGES_CAP = 32_768;

function getTokenRuntimeLimits(profile = getCachedModelProfile()) {
  const safeProfile = profile && typeof profile === "object" ? profile : {};
  const ramGB = Number(safeProfile.ramGB || 0);
  const vramGB = Number(safeProfile.vramGB || 0);

  let ramContextMax = 8_192;
  if (ramGB >= 128) ramContextMax = 262_144;
  else if (ramGB >= 64) ramContextMax = 131_072;
  else if (ramGB >= 32) ramContextMax = 65_536;
  else if (ramGB >= 24) ramContextMax = 49_152;
  else if (ramGB >= 16) ramContextMax = 32_768;
  else if (ramGB >= 12) ramContextMax = 24_576;
  else if (ramGB >= 8) ramContextMax = 16_384;

  let vramContextMax = 8_192;
  if (vramGB >= 24) vramContextMax = 131_072;
  else if (vramGB >= 16) vramContextMax = 98_304;
  else if (vramGB >= 12) vramContextMax = 65_536;
  else if (vramGB >= 8) vramContextMax = 49_152;
  else if (vramGB >= 6) vramContextMax = 32_768;
  else if (vramGB >= 4) vramContextMax = 24_576;

  const contextMax = clampInt(
    Math.max(ramContextMax, vramContextMax, MIN_CONTEXT_TOKENS),
    MIN_CONTEXT_TOKENS,
    ABSOLUTE_MAX_CONTEXT_TOKENS,
    8_192,
  );
  const contextStep = contextMax >= 65_536 ? 4_096 : 2_048;
  const maxTokensMax = clampInt(
    Math.floor(contextMax * 0.5),
    MIN_RESPONSE_TOKENS,
    ABSOLUTE_MAX_RESPONSE_TOKENS,
    1_300,
  );
  const maxTokensStep = maxTokensMax >= 8_192 ? 256 : 64;
  const maxMessagesMax = clampInt(
    Math.floor(contextMax / 4),
    64,
    MAX_CHAT_MESSAGES_CAP,
    2_048,
  );
  const reasoningBudgetMax = maxTokensMax;

  return {
    profileClass: String(safeProfile.target || "machine"),
    contextTokens: { min: MIN_CONTEXT_TOKENS, max: contextMax, step: contextStep },
    maxTokens: { min: MIN_RESPONSE_TOKENS, max: maxTokensMax, step: maxTokensStep },
    maxMessages: { min: 8, max: maxMessagesMax, step: 8 },
    reasoningBudget: { min: 0, max: reasoningBudgetMax, step: maxTokensStep },
  };
}

function clampContextTokens(value, limits = getTokenRuntimeLimits()) {
  const maxContextTokens = Number(limits?.contextTokens?.max || MIN_CONTEXT_TOKENS);
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.min(maxContextTokens, 8192);
  return Math.min(maxContextTokens, Math.max(MIN_CONTEXT_TOKENS, Math.round(n)));
}

function clampInt(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampResponseTokens(value, limits = getTokenRuntimeLimits()) {
  const maxResponseTokens = Number(limits?.maxTokens?.max || ABSOLUTE_MAX_RESPONSE_TOKENS);
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.min(maxResponseTokens, 1300);
  return Math.min(maxResponseTokens, Math.max(MIN_RESPONSE_TOKENS, Math.round(n)));
}

function clampReasoningBudget(value, limits = getTokenRuntimeLimits()) {
  const maxBudget = Number(limits?.reasoningBudget?.max || ABSOLUTE_MAX_RESPONSE_TOKENS);
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(maxBudget, Math.max(0, Math.round(n)));
}

function clampMaxMessages(value, limits = getTokenRuntimeLimits()) {
  const maxMessages = Number(limits?.maxMessages?.max || MAX_CHAT_MESSAGES_CAP);
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.min(maxMessages, 32);
  return Math.min(maxMessages, Math.max(8, Math.round(n)));
}

const TOOLS_PROMPT_BLOCK = buildToolsPromptBlock();

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
    instruction: "Maksymalna starannosc: rozpoznanie zaleznosci, etapowe wdrozenie, odzysk po bledach i mocniejsza weryfikacja.",
  },
};

const CORE_SYSTEM_PROMPT = `Jestes EndoCode: lokalnym agentem kodujacym i produkcyjnym.
Pracujesz na lokalnych modelach, lokalnych plikach i jawnych narzedziach. UI pokazuje uzytkownikowi Twoje kroki.

AUTONOMIA:
- Dzialaj autonomicznie: sam zdecyduj czy potrzebny jest tool czy final.
- Tryb runtime v2: zwracaj TYLKO jeden obiekt JSON akcji:
  {"tool":"nazwa","args":{...}} albo {"final":"odpowiedz po polsku"}.
- Zero prose poza JSON. Zero markdown. Zero tablic.
- Wyjatek dla patch-first: przy zadaniach filesystem mozesz zwrocic bezposrednio surowe bloki SEARCH/REPLACE (Aider-style), a runtime zamieni je na patch_batch.
- Gdy potrzebujesz doprecyzowania od uzytkownika, zwroc to jako {"final":"pytanie"}.
- Gdy odpowiedz ma byc finalna, zwroc jasny final dla uzytkownika.

DOSTEPNE NARZEDZIA:
${TOOLS_PROMPT_BLOCK}

PODSTAWOWY LOOP:
1. Zrozum zadanie i sprawdz obecny folder.
2. Przed edycja istniejacego pliku przeczytaj istotny fragment.
3. Zmieniaj najmniejszy sensowny fragment. Nie przepisuj calego pliku dla drobnej poprawki.
4. Po bledzie przeczytaj dokladna tresc bledu, popraw przyczyne i sprobuj ponownie.
5. Po zmianie uruchom waska weryfikacje: syntax check, test, smoke test albo odczyt pliku.
6. Final po polsku: co zmieniono, jakie pliki, jaka weryfikacja.

ZASADY EDYCJI:
- Preferuj mechanike patch-first: patch_edit lub patch_batch z malymi, precyzyjnymi blokami.
- SEARCH musi byc dokladnym fragmentem z pliku (zachowaj whitespace i wciecia).
- Gdy SEARCH nie pasuje, najpierw read_file i popraw blok SEARCH, zamiast przepisywac caly plik.
- Dla nowych plikow mozna uzyc write_file overwrite.
- Dla istniejacych plikow preferuj patch_edit/patch_batch z precyzyjnym SEARCH.
- Append stosuj do celowych dopisek albo dzielenia duzego pliku na fragmenty.
- Pelny overwrite istniejacego pliku tylko gdy plik jest generowany, bardzo maly, albo uzytkownik wyraznie chce przepisania.
- SyntaxError/build error: nie panikuj. Odczytaj plik i linie z bledu, popraw minimalny region, rerun tego samego checka.
- Jesli zapis sie nie uda, wyjasnij sobie powod z bledu: brak folderu -> mkdir; za dlugi content -> mniejsze chunki; odmowa -> alternatywa w workspace.

ZASADY NARZEDZI I SIECI:
- Nie zgaduj URL-i. Przy 404/403 wroc do strony glownej, dokumentacji, API albo uzyj extract_media.
- Nie powtarzaj identycznego nieudanego wywolania narzedzia. Po drugim podobnym bledzie zmien taktyke.
- Fetch nie renderuje JavaScriptu. Preferuj API JSON/CSV/XML lub stabilne zrodla.
- Pobieraj i zapisuj duze odpowiedzi jako pliki, nie wklejaj ich w JSON.
- Decyduj samodzielnie: gdy odpowiedz wymaga realnej weryfikacji, uzyj narzedzi zamiast zgadywac.
- Gdy korzystasz z internetu, final ma zawierac sekcje "Źródła:" z URL-ami faktycznie uzytymi do odpowiedzi.

ARTEFAKTY:
- Artefakty tworz lokalnie i trzymaj je w workspace.
- Dla dokumentow i prezentacji zachowaj zrodlo Markdown/HTML, gdy ulatwia to poprawki.
- Estetyka ma pasowac do zadania: narzedzia operacyjne maja byc czytelne i zwarte; prezentacje i strony moga byc bardziej dopracowane wizualnie.
- Gdy uzytkownik prosi o "ladna", "rozbudowana", "obszerna" strone: NIE koncz na minimalnym placeholderze. Dostarcz co najmniej komplet index.html + style.css (+ opcjonalnie script.js) i sensowna strukture sekcji.

ODZYSK PO PROBLEMACH:
- Brak narzedzia/dependency: sprawdz PATH albo lokalne skrypty; zaproponuj lub wykonaj lokalna instalacje tylko gdy to uzasadnione.
- Brak uprawnien: zapisz w bezpiecznym folderze workspace i powiedz dlaczego.
- Model zwrocil blad formatu akcji: popraw tylko format kontraktu (NOTE/FINAL/TOOL/ARGS), nie zmieniaj celu zadania.
- Jesli nie da sie kontynuowac, final musi podac konkretna przyczyne i najblizszy mozliwy nastepny krok.`;

const AGENT_GUIDANCE_MAX_CHARS = 18000;
const ENABLE_AGENT_DEBUG_LOG = false;

const SKILL_CATALOG = [];

let mainWindow;
let serverProcess = null;
let serverOwned = false;
let runningModelId = null;
let runInProgress = false;
let runAbortController = null;
const runQueue = [];
let runQueueActive = false;
let runtimeEngine = null;
let agentCore = null;
let lastChatLookupQuery = "";
let agentRuntime = "v2";
let currentAgentIntentClass = "general";
let currentAgentUserPrompt = "";
const ACTION_REFLECTION_MIN = 2;
const agentRecoveryMetrics = {
  parseErrors: 0,
  schemaErrors: 0,
  toolErrors: 0,
  naturalTextRecoveries: 0,
  partialJsonRecoveries: 0,
  repairAttempts: 0,
};
let accessLevel = "sandbox"; // "sandbox" or "full"
let chatHistory = [];
let currentChatId = null;
const telemetryMonitor = createTelemetryMonitor();
const baselineMetrics = createBaselineMetrics();
let runtimeManifestStore = null;
let runtimeBackendStatus = {
  expectedBackend: "unknown",
  activeBackend: "unknown",
  validation: "unknown",
  detail: "",
  lastCheckedAt: "",
};
let instructionPolicyMeta = { loadedFiles: [], omittedFiles: [], sizeChars: 0, hash: "" };

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
const debugLogState = {
  lastThinkingDeltaAt: 0,
  thinkingDeltaCount: 0,
  lastThinkingStep: null,
};

function resetAgentRecoveryMetrics() {
  for (const key of Object.keys(agentRecoveryMetrics)) agentRecoveryMetrics[key] = 0;
}

function bumpAgentRecoveryMetric(key) {
  if (!Object.hasOwn(agentRecoveryMetrics, key)) return;
  agentRecoveryMetrics[key] += 1;
}

function buildQuickChoicesForFinal(finalText = "", intentClass = "general", metrics = {}) {
  const text = String(finalText || "").trim();
  if (!text) return null;
  const isQuestionLike = /[?？]\s*$/.test(text) || /\b(czy|wybierz|chcesz|which|choose)\b/i.test(text);
  if (!isQuestionLike) return null;

  if (intentClass === "web") {
    return {
      title: "Wybierz dalszy kierunek",
      options: [
        { key: "A", label: "A: Szukaj dalej (inne źródła)", prompt: "Szukaj dalej w innych źródłach i porównaj informacje." },
        { key: "B", label: "B: Podsumowanie krótkie", prompt: "Zrób krótkie podsumowanie na podstawie już zebranych danych." },
        { key: "C", label: "C: Podsumowanie szczegółowe", prompt: "Zrób szczegółowe podsumowanie z zaznaczeniem niepewności i rozbieżności." },
        { key: "D", label: "D: Tylko wiarygodne źródła", prompt: "Użyj tylko bardziej wiarygodnych źródeł i odfiltruj serwisy plotkarskie." },
      ],
      otherLabel: "Other: własna odpowiedź",
      reason: metrics?.toolErrors > 0 || metrics?.parseErrors > 0 ? "recovery" : "question",
    };
  }

  return {
    title: "Wybierz dalszy kierunek",
    options: [
      { key: "A", label: "A: Kontynuuj automatycznie", prompt: "Kontynuuj zadanie autonomicznie najlepszą strategią." },
      { key: "B", label: "B: Wersja krótka", prompt: "Daj krótką odpowiedź końcową." },
      { key: "C", label: "C: Wersja szczegółowa", prompt: "Daj szczegółową odpowiedź końcową." },
      { key: "D", label: "D: Wyjaśnij plan krok po kroku", prompt: "Wyjaśnij plan krok po kroku i wykonaj go." },
    ],
    otherLabel: "Other: własna odpowiedź",
    reason: "question",
  };
}

function appendAgentDebugLog(type, payload = {}) {
  if (!ENABLE_AGENT_DEBUG_LOG) return;
  try {
    const interesting = new Set([
      "run-start",
      "thinking-start",
      "thinking-delta",
      "thinking-end",
      "model-raw",
      "parse-error",
      "tool-start",
      "tool-result",
      "note",
      "final",
      "run-end",
    ]);
    if (!interesting.has(type)) return;
    const now = Date.now();
    if (type === "thinking-start") {
      debugLogState.lastThinkingStep = payload?.step ?? null;
      debugLogState.thinkingDeltaCount = 0;
      debugLogState.lastThinkingDeltaAt = 0;
    }
    if (type === "thinking-delta") {
      debugLogState.thinkingDeltaCount += 1;
      const throttleMs = 1200;
      if (now - debugLogState.lastThinkingDeltaAt < throttleMs) return;
      debugLogState.lastThinkingDeltaAt = now;
    }
    const candidateDirs = [];
    if (ENDOCODE_HOME) candidateDirs.push(path.join(ENDOCODE_HOME, "logs"));
    if (workspaceRoot) candidateDirs.push(path.join(workspaceRoot, ".endocode", "logs"));
    if (!candidateDirs.length) return;
    let compactPayload = { ...payload };
    if (type === "thinking-delta") {
      compactPayload = {
        step: payload?.step ?? debugLogState.lastThinkingStep,
        deltasSeen: debugLogState.thinkingDeltaCount,
        textPreview: String(payload?.text || "").slice(0, 120),
        fullChars: typeof payload?.full === "string" ? payload.full.length : 0,
      };
    }
    if (typeof compactPayload.raw === "string" && compactPayload.raw.length > 1000) {
      compactPayload.raw = `${compactPayload.raw.slice(0, 1000)}\n...[truncated]`;
    }
    if (typeof compactPayload.full === "string" && compactPayload.full.length > 1000) {
      compactPayload.full = `${compactPayload.full.slice(0, 1000)}\n...[truncated]`;
    }
    if (typeof compactPayload.text === "string" && compactPayload.text.length > 400) {
      compactPayload.text = `${compactPayload.text.slice(0, 400)}...[truncated]`;
    }
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      type,
      modelId: selectedModelId,
      cwd: (() => {
        try { return relativeToRoot(cwd); } catch { return String(cwd || ""); }
      })(),
      payload: compactPayload,
    })}\n`;
    for (const logsDir of candidateDirs) {
      try {
        fs.mkdirSync(logsDir, { recursive: true });
        fs.appendFileSync(path.join(logsDir, "agent-think.log"), line, "utf8");
      } catch {
        // try next location
      }
    }
  } catch {
    // ignore debug logging errors
  }
}

function emit(type, payload = {}) {
  appendAgentDebugLog(type, payload);
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

function findEndocodeHome() {
  const starts = [
    process.env.ENDOCODE_HOME,
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

const ENDOCODE_HOME = findEndocodeHome();
runtimeManifestStore = createRuntimeManifestStore({ appHome: ENDOCODE_HOME });
const bootSettings = readJsonFile(path.join(ENDOCODE_HOME, "config", "endocode-state.json"), {});
let workspaceRoot = path.resolve(bootSettings.workspaceRoot || path.join(ENDOCODE_HOME, "workspace"));
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
  const catalog = readJsonFile(path.join(ENDOCODE_HOME, "config", "models.json"), fallback);
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
  const data = readJsonFile(path.join(ENDOCODE_HOME, "config", "model-presets.json"), { models: [] });
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
  const gpuAccelerated = String(profile?.gpuBackendClass || "cpu-only") !== "cpu-only";
  const threadProfile = getRuntimeThreadProfile(profile, category);

  const config = { ...rawConfig };
  config.contextTokens = clampContextTokens(clampInt(
    config.contextTokens ?? 8192,
    SAFE_RUNTIME_LIMITS.contextMin,
    SAFE_RUNTIME_LIMITS.contextMax,
    8192,
  ));
  if (category !== "small" || sizeGB >= 6) config.contextTokens = Math.min(config.contextTokens, 12288);
  if (sizeGB >= 10 || category === "large") config.contextTokens = Math.min(config.contextTokens, 8192);
  if (sizeGB >= 16) config.contextTokens = Math.min(config.contextTokens, 6144);
  if (Number(profile?.ramGB || 0) > 0 && Number(profile.ramGB) < 24) config.contextTokens = Math.min(config.contextTokens, 4096);
  if (gpuAccelerated && Number(profile?.vramGB || 0) > 0 && Number(profile.vramGB) < 10) {
    config.contextTokens = Math.min(config.contextTokens, 6144);
  }

  config.threads = clampInt(
    config.threads ?? threadProfile.threads,
    SAFE_RUNTIME_LIMITS.threadsMin,
    SAFE_RUNTIME_LIMITS.threadsMax,
    threadProfile.threads,
  );
  config.threadsBatch = clampInt(
    config.threadsBatch ?? threadProfile.threadsBatch,
    SAFE_RUNTIME_LIMITS.threadsBatchMin,
    SAFE_RUNTIME_LIMITS.threadsBatchMax,
    threadProfile.threadsBatch,
  );
  if (config.threadsBatch < config.threads) config.threadsBatch = config.threads;

  config.batchSize = clampInt(
    config.batchSize ?? (gpuAccelerated ? 512 : 768),
    SAFE_RUNTIME_LIMITS.batchMin,
    SAFE_RUNTIME_LIMITS.batchMax,
    gpuAccelerated ? 512 : 768,
  );
  config.ubatchSize = clampInt(
    config.ubatchSize ?? Math.max(128, Math.floor(config.batchSize / 2)),
    SAFE_RUNTIME_LIMITS.ubatchMin,
    SAFE_RUNTIME_LIMITS.ubatchMax,
    Math.max(128, Math.floor(config.batchSize / 2)),
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
  config.cacheTypeK = config.cacheTypeK || (gpuAccelerated ? "q4_0" : "q8_0");
  config.cacheTypeV = config.cacheTypeV || (gpuAccelerated ? "q4_0" : "q8_0");
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
  writeJsonFile(path.join(ENDOCODE_HOME, "config", "models.json"), {
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
    const modelPath = path.resolve(ENDOCODE_HOME, model.file);
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
  return readJsonFile(path.join(ENDOCODE_HOME, "config", "endocode-state.json"), {});
}

function saveAppSettings() {
  writeJsonFile(path.join(ENDOCODE_HOME, "config", "endocode-state.json"), {
    selectedModelId,
    reasoningLevel: selectedReasoning,
    agentRuntime,
    accessLevel,
    customModelSettingsByModelId,
    workspaceRoot,
  });
}

function getChatHistoryPath() {
  return path.join(ENDOCODE_HOME, "config", "chat-history.json");
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

function getActiveSkillsPrompt() {
  return "";
}

function refreshSystemPrompt() {
  if (Array.isArray(messages) && messages[0]?.role === "system") {
    messages[0] = { role: "system", content: createSystemPrompt() };
  }
}

// Skills management removed.

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

function getRuntimeThreadProfile(profile = {}, category = "medium") {
  const logical = Math.max(2, os.cpus().length || 8);
  const physicalEstimate = Math.max(2, Math.floor(logical / 2));
  const backendClass = String(profile.gpuBackendClass || "cpu-only");
  const gpuAccelerated = backendClass !== "cpu-only";
  if (gpuAccelerated) {
    // With GPU offload, fewer CPU threads usually improves token latency.
    const threads = Math.max(4, Math.min(8, physicalEstimate));
    const threadsBatch = Math.max(threads, Math.min(16, threads * 2));
    return { threads, threadsBatch };
  }
  const cpuThreads = category === "large"
    ? Math.max(4, Math.min(physicalEstimate, 12))
    : Math.max(4, Math.min(logical, 16));
  const threadsBatch = Math.max(cpuThreads, Math.min(20, cpuThreads + 2));
  return { threads: cpuThreads, threadsBatch };
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

  // Runtime-first defaults: keep context conservative to preserve full GPU offload.
  let contextTokens = category === "small" ? 8192 : category === "medium" ? 6144 : 4096;
  if (sizeGB > 16) contextTokens = 4096;
  if (sizeGB > 24) contextTokens = 3072;
  if (profile.ramGB < 24) contextTokens = Math.min(contextTokens, 4096);
  if (Number(profile.vramGB || 0) >= 20 && category === "small") contextTokens = Math.max(contextTokens, 12288);
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

  const threadProfile = getRuntimeThreadProfile(profile, category);
  const vramGB = Number(profile.vramGB || 0);
  const gpuAccelerated = String(profile.gpuBackendClass || "cpu-only") !== "cpu-only";
  const batchSize = gpuAccelerated
    ? (vramGB >= 16 ? 1024 : vramGB >= 10 ? 768 : vramGB >= 6 ? 512 : 256)
    : (category === "small" ? 1024 : 512);
  const ubatchSize = Math.max(64, Math.min(512, Math.floor(batchSize / 2)));

  return applyRuntimeSafetyGuards({
    category,
    contextTokens,
    gpuLayers,
    gpuLayerFallbacks: createGpuLayerFallbacks(gpuLayers, profile.gpuBackendClass),
    threads: threadProfile.threads,
    threadsBatch: threadProfile.threadsBatch,
    batchSize,
    ubatchSize,
    parallel: 1,
    flashAttention: "on",
    cacheTypeK: gpuAccelerated ? "q4_0" : "q8_0",
    cacheTypeV: gpuAccelerated ? "q4_0" : "q8_0",
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
      defaultPath: path.join(ENDOCODE_HOME, "models"),
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
  const modelDir = path.join(ENDOCODE_HOME, "models");
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

async function fetchWithRetry(url, init = {}, timeouts = [2500, 5000]) {
  let lastError = null;
  for (let i = 0; i < timeouts.length; i += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeouts[i]) });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("fetch failed");
}

async function fetchLivePageSnippet(url) {
  if (!isHttpUrl(url)) return "";
  try {
    const response = await fetchWithRetry(url, {
      redirect: "follow",
      headers: { "User-Agent": "EndoCode-Desktop-App" },
    }, [CHAT_WEB_PAGE_FETCH_TIMEOUT_MS, CHAT_WEB_PAGE_FETCH_RETRY_TIMEOUT_MS]);
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
  if (!isHttpUrl(url)) {
    return { summary: "", signals: [], status: 0, ok: false, error: "invalid-url" };
  }
  try {
    const response = await fetchWithRetry(url, {
      redirect: "follow",
      headers: { "User-Agent": "EndoCode-Desktop-App" },
    }, [CHAT_WEB_PAGE_FETCH_TIMEOUT_MS, CHAT_WEB_PAGE_FETCH_RETRY_TIMEOUT_MS]);
    if (!response.ok) {
      return { summary: "", signals: [], status: response.status || 0, ok: false, error: "http-error" };
    }
    const html = await response.text();
    const visible = stripHtmlToVisibleText(html);
    const summary = compactWebSnippet(visible).slice(0, CHAT_WEB_PAGE_SNIPPET_CHARS);
    const signals = extractHtmlSignals(html);
    return { summary, signals, status: response.status || 200, ok: true, error: "" };
  } catch (error) {
    return {
      summary: "",
      signals: [],
      status: 0,
      ok: false,
      error: compactWebSnippet(error?.message || "fetch-error"),
    };
  }
}

function classifyWebSourceQuality(insight = {}) {
  const summaryLen = String(insight.summary || "").trim().length;
  const signalCount = Array.isArray(insight.signals) ? insight.signals.length : 0;
  const isReachable = Boolean(insight.ok) || (Number(insight.status) >= 200 && Number(insight.status) < 400);
  if (!isReachable) return "niedostepny";
  if (summaryLen >= CHAT_WEB_SOURCE_GOOD_SNIPPET_CHARS || signalCount >= 2) return "ok";
  if (summaryLen >= CHAT_WEB_SOURCE_WEAK_SNIPPET_CHARS || signalCount >= 1) return "slaby";
  return "slaby";
}

function summarizeWebLookupQuality(sourceDiagnostics = []) {
  const counts = { ok: 0, slaby: 0, niedostepny: 0 };
  for (const item of sourceDiagnostics) {
    const quality = item?.quality;
    if (quality === "ok" || quality === "slaby" || quality === "niedostepny") counts[quality] += 1;
  }
  const total = sourceDiagnostics.length;
  const usable = counts.ok + counts.slaby;
  let confidence = "low";
  if (counts.ok >= 2 || (counts.ok >= 1 && usable >= 2)) confidence = "high";
  else if (counts.ok >= 1 || counts.slaby >= 2) confidence = "medium";
  return { confidence, total, usable, counts };
}

function buildWebConfidenceInstruction(webLookup = null) {
  const confidence = String(webLookup?.quality?.confidence || "low").toLowerCase();
  const qualityLine = `Pewnosc zrodel web: ${confidence}.`;
  if (confidence === "high") {
    return `${qualityLine} Uzywaj tylko faktow, ktore maja oparcie w zalaczonych snippetach/URL. Nie dopisuj brakujacych cen, opinii ani rankingow.`;
  }
  if (confidence === "medium") {
    return `${qualityLine} Traktuj dane jako czesciowo potwierdzone: podaj tylko informacje wspierane snippetami i wyraznie oddziel to od ogolnych wskazowek.`;
  }
  return `${qualityLine} Dane sa slabe lub niepelne: nie podawaj konkretnych liczb, cen, ocen, nazw ofert ani rekomendacji \"najlepsza opcja\" bez doslownego potwierdzenia w snippetach.`;
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
    const response = await fetchWithRetry(url, {
      redirect: "follow",
      headers: { "User-Agent": "EndoCode-Desktop-App" },
    }, [CHAT_WEB_LOOKUP_TIMEOUT_MS, CHAT_WEB_LOOKUP_RETRY_TIMEOUT_MS]);
    if (!response.ok) return [];
    const html = await response.text();
    return extractDuckDuckGoHtmlLinks(html);
  } catch {
    return [];
  }
}

async function searchBraveWeb(query) {
  if (!BRAVE_SEARCH_API_KEY) return { links: [], sources: [] };
  const q = normalizeWebQuery(query);
  if (!q) return { links: [], sources: [] };
  const url = `${BRAVE_SEARCH_API_URL}?q=${encodeURIComponent(q)}&count=${Math.min(10, CHAT_WEB_SEARCH_RESULT_LIMIT)}`;
  try {
    const response = await fetchWithRetry(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": BRAVE_SEARCH_API_KEY,
        "User-Agent": "EndoCode-Desktop-App",
      },
    }, [CHAT_WEB_LOOKUP_TIMEOUT_MS, CHAT_WEB_LOOKUP_RETRY_TIMEOUT_MS]);
    if (!response.ok) return { links: [], sources: [] };
    const data = await response.json().catch(() => ({}));
    const results = Array.isArray(data?.web?.results) ? data.web.results : [];
    const links = [];
    const sources = [];
    const seen = new Set();
    for (const entry of results) {
      const link = String(entry?.url || "").trim();
      if (!isHttpUrl(link) || seen.has(link)) continue;
      seen.add(link);
      links.push(link);
      sources.push({
        title: compactWebSnippet(entry?.title || "Brave result"),
        url: link,
        snippet: compactWebSnippet(entry?.description || ""),
      });
      if (links.length >= CHAT_WEB_SEARCH_RESULT_LIMIT) break;
    }
    return { links, sources };
  } catch {
    return { links: [], sources: [] };
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
- Pewnosc zrodel: ${classifyWebSourceQuality(domainInfo)}
- [LIVE:DOMAIN] ${domainInfo.summary || "Brak krótkiego streszczenia strony"}
${signalLines.join("\n")}`;
      const sourceDiagnostics = [{
        url: domainUrl,
        status: Number(domainInfo.status || 0),
        quality: classifyWebSourceQuality(domainInfo),
        summaryChars: String(domainInfo.summary || "").length,
        signalCount: Array.isArray(domainInfo.signals) ? domainInfo.signals.length : 0,
      }];
      const quality = summarizeWebLookupQuality(sourceDiagnostics);
      return {
        context: directContext,
        sources: [{ title: `Strona ${domain}`, url: domainUrl, snippet: domainInfo.summary || domainInfo.signals?.[0] || "" }],
        visitedUrls: [domainUrl],
        sourceDiagnostics,
        quality,
        lookupUrl: "",
        provider: "domain-first",
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
      let data;
      try {
        data = await fetchJson(lookupUrl, { signal: AbortSignal.timeout(CHAT_WEB_LOOKUP_TIMEOUT_MS) });
      } catch {
        data = await fetchJson(lookupUrl, { signal: AbortSignal.timeout(CHAT_WEB_LOOKUP_RETRY_TIMEOUT_MS) });
      }
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
      if (!candidateUrls.length && BRAVE_SEARCH_API_KEY) {
        const brave = await searchBraveWeb(candidateQuery);
        if (Array.isArray(brave.sources) && brave.sources.length) {
          for (const source of brave.sources) {
            if (!source?.url) continue;
            if (!dedupedSources.some((entry) => entry.url === source.url)) dedupedSources.push(source);
          }
        }
        if (Array.isArray(brave.links) && brave.links.length) {
          candidateUrls = brave.links.slice(0, CHAT_WEB_PAGE_FETCH_MAX_SOURCES);
        }
      }
      if (!candidateUrls.length) {
        candidateUrls = (await searchWebLinks(candidateQuery)).slice(0, CHAT_WEB_PAGE_FETCH_MAX_SOURCES);
      }
      const liveInsights = await Promise.all(candidateUrls.map((url) => fetchLivePageInsights(url)));
      const sourceDiagnostics = [];
      for (let i = 0; i < candidateUrls.length; i += 1) {
        const insight = liveInsights[i] || { summary: "", signals: [], status: 0, ok: false, error: "missing-insight" };
        const snippet = compactWebSnippet(insight.summary || "");
        const signals = Array.isArray(insight.signals) ? insight.signals.slice(0, 3) : [];
        const quality = classifyWebSourceQuality(insight);
        sourceDiagnostics.push({
          url: candidateUrls[i],
          status: Number(insight.status || 0),
          quality,
          summaryChars: snippet.length,
          signalCount: signals.length,
          error: insight.error || "",
        });
        if (!snippet && !signals.length) continue;
        lines.push(`- [LIVE:${i + 1}|${quality}] ${snippet || "Brak krótkiego streszczenia."}`);
        for (const signal of signals) lines.push(`- [HTML:${i + 1}] ${signal}`);
        if (!dedupedSources.some((source) => source.url === candidateUrls[i])) {
          dedupedSources.push({
            title: `Web result ${i + 1}`,
            url: candidateUrls[i],
            snippet: snippet || signals[0] || "",
          });
        }
      }
      const quality = summarizeWebLookupQuality(sourceDiagnostics);
      lines.push(`- [QUALITY] confidence=${quality.confidence}; ok=${quality.counts.ok}; slaby=${quality.counts.slaby}; niedostepny=${quality.counts.niedostepny}`);

      const result = {
        context: lines.length
          ? `Kontekst z internetu (ultra-light, moze byc niepelny):
- Pipeline: interpret query -> lookup -> fetch live page -> extract visible text + general html digest
- Zapytanie lookup: ${candidateQuery}
${lines.join("\n")}`
          : "",
        sources: dedupedSources,
        visitedUrls: candidateUrls,
        sourceDiagnostics,
        quality,
        lookupUrl,
        provider: BRAVE_SEARCH_API_KEY ? "brave+ddg" : "ddg",
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
        sourceDiagnostics: [],
        quality: { confidence: "low", total: 0, usable: 0, counts: { ok: 0, slaby: 0, niedostepny: 0 } },
        lookupUrl,
        provider: BRAVE_SEARCH_API_KEY ? "brave+ddg" : "ddg",
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
    sourceDiagnostics: [],
    quality: { confidence: "low", total: 0, usable: 0, counts: { ok: 0, slaby: 0, niedostepny: 0 } },
    provider: BRAVE_SEARCH_API_KEY ? "brave+ddg" : "ddg",
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
  const quality = webLookup?.quality || { confidence: "low", counts: { ok: 0, slaby: 0, niedostepny: 0 } };
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

Ocena jakosci zrodel: confidence=${quality.confidence}; ok=${quality?.counts?.ok || 0}; slaby=${quality?.counts?.slaby || 0}; niedostepny=${quality?.counts?.niedostepny || 0}

${lines.length ? lines.join("\n") : "- Brak snippetow; znaleziono tylko URL-e."}

URL-e do sprawdzenia:
${uniqueUrls.length ? uniqueUrls.map((url) => `- ${url}`).join("\n") : "- Brak URL-i"}

Podsumuj to, co da sie potwierdzic z powyzszych danych. Nie wymyslaj cen, opinii i rankingow bez doslownego pokrycia w snippetach. Jesli dane sa niepelne, napisz wprost czego brakuje, ale nadal podaj to co znaleziono.`;
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

function getRecommendedSettingsForModelId(modelId = selectedModelId) {
  const catalog = loadModelCatalog();
  const model = catalog.models.find((entry) => entry.id === modelId) || getModelConfig();
  const runtime = createRuntimeModelConfig(model);
  const tokenLimits = getTokenRuntimeLimits();
  const recommended = {
    contextTokens: clampContextTokens(runtime.contextTokens ?? model?.contextTokens ?? 8192, tokenLimits),
    gpuLayers: clampRuntimeNumber(runtime.gpuLayers ?? model?.gpuLayers ?? 99, 0, 99),
    maxTokens: clampResponseTokens(model?.maxTokens ?? 1300, tokenLimits),
    maxMessages: clampMaxMessages(model?.maxMessages ?? 32, tokenLimits),
    threads: clampRuntimeNumber(runtime.threads, SAFE_RUNTIME_LIMITS.threadsMin, SAFE_RUNTIME_LIMITS.threadsMax),
    threadsBatch: clampRuntimeNumber(runtime.threadsBatch, SAFE_RUNTIME_LIMITS.threadsBatchMin, SAFE_RUNTIME_LIMITS.threadsBatchMax),
    batchSize: clampRuntimeNumber(runtime.batchSize, SAFE_RUNTIME_LIMITS.batchMin, SAFE_RUNTIME_LIMITS.batchMax),
    ubatchSize: clampRuntimeNumber(runtime.ubatchSize, SAFE_RUNTIME_LIMITS.ubatchMin, SAFE_RUNTIME_LIMITS.ubatchMax),
    parallel: clampRuntimeNumber(runtime.parallel, SAFE_RUNTIME_LIMITS.parallelMin, SAFE_RUNTIME_LIMITS.parallelMax),
    flashAttention: runtime.flashAttention || "on",
    cacheTypeK: runtime.cacheTypeK || "q8_0",
    cacheTypeV: runtime.cacheTypeV || "q8_0",
  };
  return sanitizeSettingsPatch(recommended);
}

function resetModelSettingsForId(modelId) {
  customModelSettingsByModelId[modelId] = { ...DEFAULT_MODEL_SETTINGS, ...getRecommendedSettingsForModelId(modelId) };
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
  const dir = path.join(ENDOCODE_HOME, "config", "agent-playbooks");
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
  const engine = createInstructionPolicyEngine({
    appHome: ENDOCODE_HOME,
    maxChars: AGENT_GUIDANCE_MAX_CHARS,
    readFile: readInstructionFile,
    playbookFilesProvider: getAgentPlaybookFiles,
  });
  const built = engine.buildPrompt(workspaceRoot);
  const hash = crypto.createHash("sha256").update(String(built.prompt || ""), "utf8").digest("hex").slice(0, 16);
  instructionPolicyMeta = { ...(built.meta || {}), hash };
  return built.prompt || "";
}

function createSystemPrompt() {
  const model = getModelConfig();
  const reasoning = getReasoningProfile();
  const skillsPrompt = "";
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
    const modelPath = model.file ? path.resolve(ENDOCODE_HOME, model.file) : null;
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
  const modelPath = path.resolve(ENDOCODE_HOME, model.file);
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
  return os.homedir() || path.join(ENDOCODE_HOME, "workspace");
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
  return runtimeManifestStore?.getActiveServerPath?.() || null;
}

function detectLoadedBackendsFromVersion(serverExe) {
  try {
    const result = spawnSync(serverExe, ["--version"], {
      cwd: path.dirname(serverExe),
      windowsHide: true,
      encoding: "utf8",
      timeout: 12000,
    });
    const out = `${result?.stdout || ""}\n${result?.stderr || ""}`.toLowerCase();
    return {
      cuda: /loaded cuda backend|ggml-cuda/i.test(out),
      vulkan: /loaded vulkan backend|ggml-vulkan/i.test(out),
      cpu: /loaded cpu backend|ggml-cpu/i.test(out),
      raw: out,
    };
  } catch {
    return { cuda: false, vulkan: false, cpu: false, raw: "" };
  }
}

function detectInstallTarget() {
  return detectInstallTargetByPolicy(process.platform, probeGpuInfo());
}

function rankRuntimeAssets(assets, target) {
  return rankRuntimeAssetsByPolicy(assets, target);
}

function findCudaCompanionAsset(assets, target) {
  if (!Array.isArray(assets) || !assets.length) return null;
  const platformToken = target.platform === "linux" ? "-bin-linux-" : "-bin-win-";
  const candidates = assets.filter((asset) => {
    const name = String(asset?.name || "").toLowerCase();
    return name.startsWith("cudart-")
      && name.includes(platformToken)
      && name.includes("x64")
      && name.endsWith(".zip");
  });
  return candidates[0] || null;
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

async function collectDllFilesRecursive(rootDir) {
  const out = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && /\.dll$/i.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(rootDir);
  return out;
}

async function hoistRuntimeDlls(runtimeDir) {
  const dlls = await collectDllFilesRecursive(runtimeDir);
  for (const dllPath of dlls) {
    if (path.dirname(dllPath) === runtimeDir) continue;
    const target = path.join(runtimeDir, path.basename(dllPath));
    await fsp.copyFile(dllPath, target).catch(() => {});
  }
}

async function installLlamaRuntime() {
  const alreadyInstalled = getRuntimeServerExe();
  if (alreadyInstalled) {
    const backendProbe = detectLoadedBackendsFromVersion(alreadyInstalled);
    const hasCudaPlugin = fs.existsSync(path.join(path.dirname(alreadyInstalled), "ggml-cuda.dll"));
    if (!(hasCudaPlugin && !backendProbe.cuda)) {
      await runtimeManifestStore.writeManifest({
        serverExe: alreadyInstalled,
        source: "existing",
      }).catch(() => {});
      return { ok: true, alreadyInstalled: true, serverExe: alreadyInstalled };
    }
    emit("status", {
      status: "runtime-install",
      detail: "Wykryto runtime z ggml-cuda.dll, ale backend CUDA sie nie laduje. Naprawiam instalacje...",
    });
  }

  const target = detectInstallTarget();
  emit("status", { status: "runtime-install", detail: `Wykryty target runtime: ${target.platform} + ${target.gpuVendor}.` });
  emit("status", { status: "runtime-install", detail: `Preferencja backendów: ${target.runtimePreference.join(" -> ")}.` });
  emit("status", { status: "runtime-install", detail: `Sprawdzam najnowsze wydanie llama.cpp dla ${target.platform}...` });
  emit("runtime-install-progress", { phase: "prepare", progress: 5, detail: "Pobieranie metadanych wydania..." });
  const release = await fetchJsonViaHttpsWithRetry("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", 3);

  const runtimeAssets = rankRuntimeAssets(release?.assets || [], target);
  const cudaCompanionAsset = findCudaCompanionAsset(release?.assets || [], target);
  if (!runtimeAssets.length) {
    throw new Error(`Nie znalazlem binarki llama.cpp dla targetu ${target.platform} (${target.runtimePreference.join(", ")}).`);
  }

  const runtimeDir = path.join(ENDOCODE_HOME, "runtime");
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

        if (inferBackendFromAssetName(asset.name) === "cuda" && cudaCompanionAsset?.browser_download_url) {
          const companionArchivePath = path.join(tempDir, String(cudaCompanionAsset.name).replace(/[<>:\"\\|?*]/g, "_"));
          emit("status", { status: "runtime-install", detail: `Pobieram zaleznosci CUDA: ${cudaCompanionAsset.name}` });
          emit("runtime-install-progress", { phase: "extract", progress: 88, detail: "Pobieranie cudart..." });
          await downloadFileWithProgress(cudaCompanionAsset.browser_download_url, companionArchivePath, "Pobieranie cudart");
          emit("runtime-install-progress", { phase: "extract", progress: 90, detail: "Rozpakowywanie cudart..." });
          await extractRuntimeArchive(companionArchivePath, extractDir);
          await fsp.rm(companionArchivePath, { force: true }).catch(() => {});
        }

        emit("runtime-install-progress", { phase: "install", progress: 92, detail: "Kopiowanie runtime..." });
        await fsp.rm(finalDir, { recursive: true, force: true });
        await fsp.mkdir(finalDir, { recursive: true });
        await fsp.cp(extractDir, finalDir, { recursive: true, force: true });
        await hoistRuntimeDlls(finalDir);

        const serverExe = getRuntimeServerExe();
        if (!serverExe) {
          const expectedName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
          throw new Error(`Paczka ${asset.name} nie zawiera ${expectedName}`);
        }
        emit("runtime-install-progress", { phase: "done", progress: 100, detail: "Runtime llama.cpp zainstalowany." });
        emit("status", { status: "runtime-install-complete", detail: "Runtime llama.cpp zainstalowany." });
        await runtimeManifestStore.writeManifest({
          serverExe,
          releaseTag: release?.tag_name || "latest",
          assetName: asset.name,
          installTarget: target,
          expectedBackend: inferBackendFromAssetName(asset.name),
        }).catch(() => {});
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
  return path.resolve(ENDOCODE_HOME, config.file);
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
  await fsp.mkdir(path.join(ENDOCODE_HOME, "logs"), { recursive: true });
  const outLogPath = path.join(ENDOCODE_HOME, "logs", "local-codex-server.out.log");
  const errLogPath = path.join(ENDOCODE_HOME, "logs", "local-codex-server.err.log");
  const outLog = fs.openSync(outLogPath, "a");
  const errLog = fs.openSync(errLogPath, "a");
  const serverExe = getRuntimeServerExe();
  if (!serverExe) throw new Error("Nie znaleziono runtime/llama-server.exe.");
  const runtimeManifest = runtimeManifestStore.readManifest() || {};
  const expectedBackend = String(runtimeManifest.expectedBackend || "unknown");

  emit("status", { status: "server-starting", detail: `Uruchamiam: ${config.displayName} (ctx ${contextTokens}, GPU layers ${gpuLayers}).` });
  const serverArgs = [
    "-m", modelPath,
    "-c", String(contextTokens),
    "-ngl", String(gpuLayers),
    "--host", "127.0.0.1",
    "--port", String(port),
    "--jinja",
  ];
  // Fast startup path; unknown flags are avoided for compatibility.
  if (String(config.fastStartup || "on") === "on") serverArgs.push("--no-warmup");
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
    if (serverProcess?.exitCode !== null) {
      const errTail = `${readLogTail(errLogPath, 1200)}\n${readLogTail(outLogPath, 800)}`.trim();
      throw new Error(`llama-server zakonczyl prace przed startem API.${errTail ? ` Log: ${errTail.slice(-500)}` : ""}`);
    }
    if (await isServerReady(port)) {
      const backendLog = `${readLogTail(outLogPath, 3000)}\n${readLogTail(errLogPath, 3000)}`;
      const backendByLogs = inferBackendFromLogs(backendLog);
      const backendByBinary = inferBackendFromRuntimeBinaries(serverExe);
      const gpuOffloadDetected = /offloaded\s+\d+\/\d+\s+layers?\s+to\s+gpu/i.test(backendLog);
      const activeBackend = backendByLogs !== "unknown"
        ? backendByLogs
        : (gpuOffloadDetected ? backendByBinary : backendByBinary);
      if (gpuLayers > 0 && backendByBinary === "cuda" && activeBackend !== "cuda" && !gpuOffloadDetected) {
        throw new Error("Runtime CUDA nie zostal aktywowany (ggml-cuda.dll bez zaladowanego backendu). Uruchom ponownie instalacje runtime.");
      }
      runtimeBackendStatus = {
        expectedBackend,
        activeBackend,
        validation: activeBackend !== "unknown" ? "validated" : "unverified",
        detail: activeBackend !== "unknown"
          ? `Wykryto backend ${activeBackend}${gpuOffloadDetected ? " (GPU offload potwierdzony)." : ""}.`
          : "Nie udało się jednoznacznie odczytać backendu z logów.",
        lastCheckedAt: new Date().toISOString(),
      };
      baselineMetrics.recordRuntimeLaunch(activeBackend, { expectedBackend, gpuLayers, contextTokens });
      await runtimeManifestStore.writeManifest({
        serverExe,
        expectedBackend,
        activeBackend,
        lastLaunchAt: new Date().toISOString(),
      }).catch(() => {});
      emit("status", { status: "server-ready", detail: `${config.displayName} gotowy na http://127.0.0.1:${port}` });
      return;
    }
    const elapsed = Date.now() - startedAt;
    await sleep(elapsed < 8000 ? 300 : 800);
  }
  throw new Error(`Serwer nie odpowiedzial w ciagu ${Math.round(startupTimeoutMs / 1000)} sekund.`);
}

function getRuntimeEngine() {
  if (!runtimeEngine) {
    runtimeEngine = createRuntimeEngine({
      isServerReady,
      getServerModelId,
      stopOwnedServer,
      launchServerProcess,
      getModelConfig,
      getModelPath,
      getModelFileStatus,
      getModelSettingsForId,
      resetRuntimeRecoveryState,
      baselineMetrics,
      emit,
      getSelectedModelId: () => selectedModelId,
      getRunningModelId: () => runningModelId,
      setRunningModelId: (value) => { runningModelId = value; },
    });
  }
  return runtimeEngine;
}

async function ensureServer(port = DEFAULT_PORT) {
  return getRuntimeEngine().ensureReady(port);
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
  const stillAlive = [alive ? DEFAULT_PORT : null].filter(Boolean);
  const detail = stillAlive.length
    ? `Kill switch wykonany, ale nadal odpowiadaja porty: ${stillAlive.join(", ")}.`
    : `Kill switch zakonczony. Zwolniono port ${DEFAULT_PORT}.`;
  emit("status", { status: "server-killed", detail });
  return { aborted: hadRun, ownedPid, killedPids, port: DEFAULT_PORT, alive };
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

    if (!String(fullContent || "").trim() && String(thinkingContent || "").trim()) {
      // Some models stream only reasoning-like text; treat it as content fallback.
      return { content: thinkingContent, reasoning: thinkingContent };
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
  return JSON.parse(candidate);
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

function parseActionEnvelope(raw) {
  let text = String(raw || "").trim();
  if (!text) throw new Error("Pusta odpowiedz modelu.");
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:[a-z0-9_-]+)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  if (text.includes("<<<<<<< SEARCH") && text.includes(">>>>>>> REPLACE")) {
    const blocks = parsePatchBatchText(text, "");
    if (Array.isArray(blocks) && blocks.length) {
      return {
        note: "Aider-style SEARCH/REPLACE blocks detected.",
        tool: "patch_batch",
        args: { blocks },
      };
    }
  }
  const parsed = parseJsonAction(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Action v2 requires a single JSON object.");
  }
  return parsed;
}

function sanitizeJsonCandidateText(raw) {
  return String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function autoCloseJsonObject(candidate) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of candidate) {
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
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
  }
  if (depth <= 0) return candidate;
  return `${candidate}${"}".repeat(depth)}`;
}

function parsePartialActionFromRaw(raw) {
  const text = sanitizeJsonCandidateText(raw);
  if (!text) return null;
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) return null;
  const rough = text.slice(firstBrace).trim();
  const candidates = [
    rough,
    autoCloseJsonObject(rough),
    autoCloseJsonObject(rough.replace(/,\s*([}\]])/g, "$1")),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // best-effort parser
    }
  }
  return null;
}

function buildDuckDuckGoSearchUrl(query) {
  const normalized = compactWhitespace(String(query || ""));
  if (!normalized) return "";
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(normalized)}`;
}

function extractSearchQueryFromPlannerText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const markerMatch = raw.match(/\b(?:query|fraza|zapytanie|search)\s*[:=]\s*["'`]?(.+?)["'`]?$/i);
  if (markerMatch?.[1]) return compactWhitespace(markerMatch[1]);
  const stripped = raw
    .replace(/\b(?:we need|we should|let'?s|we will|we'll|powinnismy|trzeba|nalezy)\b/gi, " ")
    .replace(/\b(?:use|uzyj(?:my)?|wyszukaj|szukaj|search|in(?: the)? web|w necie|w internecie)\b/gi, " ")
    .replace(/\b(?:fetch_url|duckduckgo|google|brave)\b/gi, " ")
    .replace(/[.:;()[\]{}]/g, " ");
  return compactWhitespace(stripped).slice(0, 220);
}

function extractUserPromptFromPlannerRaw(raw) {
  const text = String(raw || "");
  const quoted = text.match(/user wants:\s*"([^"]+)"/i);
  if (quoted?.[1]) return compactWhitespace(quoted[1]).slice(0, 220);
  const singleQuoted = text.match(/user wants:\s*'([^']+)'/i);
  if (singleQuoted?.[1]) return compactWhitespace(singleQuoted[1]).slice(0, 220);
  return "";
}

function recoverActionFromNaturalText(raw, options = {}) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  const intentClass = options.intentClass || "general";
  const userPrompt = compactWhitespace(String(options.userPrompt || "").trim());

  if (
    intentClass === "web"
    || /\b(fetch_url|internet|online|search|wyszukaj|duckduckgo)\b/i.test(text)
  ) {
    const hintedPrompt = extractUserPromptFromPlannerRaw(text);
    const query = hintedPrompt || userPrompt || extractSearchQueryFromPlannerText(text);
    if (!query) return null;
    return {
      note: "Auto-recover: parsed natural-text planner output into fetch action.",
      tool: "fetch_url",
      args: {
        url: buildDuckDuckGoSearchUrl(query),
        timeout: 20,
        raw: false,
      },
    };
  }

  // Intentionally no auto-generated "simple HTML page" fallback here.
  // It caused under-delivery for broader website requests.
  return null;
}

function inferActionFromPlannerText() {
  return null;
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
  if (["write_file", "patch_edit", "patch_batch"].includes(tool)) return 1;
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

function getJsonLineAndColumnFromIndex(text, index) {
  const safeText = String(text || "");
  const pos = Math.max(0, Math.min(Number(index) || 0, safeText.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < pos; i += 1) {
    if (safeText[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function extractJsonErrorLocation(errorMessage, text) {
  const msg = String(errorMessage || "");
  const byLineColumn = msg.match(/line\s+(\d+)\s*(?:,|and)?\s*column\s+(\d+)/i);
  if (byLineColumn) {
    return { line: Number(byLineColumn[1]), column: Number(byLineColumn[2]) };
  }
  const byPosition = msg.match(/position\s+(\d+)/i);
  if (byPosition) {
    return getJsonLineAndColumnFromIndex(text, Number(byPosition[1]));
  }
  return null;
}

function buildJsonErrorContext(raw, location, radius = 2) {
  const lines = String(raw || "").split(/\r?\n/);
  if (!location?.line || !Number.isFinite(location.line) || location.line < 1) {
    return String(raw || "").slice(0, 600);
  }
  const start = Math.max(1, location.line - radius);
  const end = Math.min(lines.length, location.line + radius);
  const out = [];
  for (let lineNo = start; lineNo <= end; lineNo += 1) {
    const marker = lineNo === location.line ? ">>" : "  ";
    out.push(`${marker} ${lineNo}: ${lines[lineNo - 1]}`);
  }
  return out.join("\n");
}

function jsonNormalizedForDrift(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/`{3,}json|`{3,}/gi, "")
    .trim();
}

function tokenSetForDrift(raw) {
  const tokens = jsonNormalizedForDrift(raw).match(/[a-zA-Z0-9_./:-]+/g) || [];
  return new Set(tokens.map((t) => t.toLowerCase()));
}

function isPatchDriftTooLarge(previousRaw, nextRaw) {
  const prev = jsonNormalizedForDrift(previousRaw);
  const next = jsonNormalizedForDrift(nextRaw);
  if (!prev || !next) return false;
  const prevLen = prev.length;
  const nextLen = next.length;
  const ratio = Math.max(prevLen, nextLen) / Math.max(1, Math.min(prevLen, nextLen));
  const prevSet = tokenSetForDrift(prev);
  const nextSet = tokenSetForDrift(next);
  let intersection = 0;
  for (const token of prevSet) {
    if (nextSet.has(token)) intersection += 1;
  }
  const union = Math.max(1, prevSet.size + nextSet.size - intersection);
  const jaccard = intersection / union;
  if (prevLen >= 100 && ratio > 2.4) return true;
  if (prevLen >= 80 && jaccard < 0.35) return true;
  return false;
}

function makeJsonRepairPrompt(error, raw, options = {}) {
  const errMsg = String(error?.message || error).slice(0, 500);
  const location = options.location || extractJsonErrorLocation(errMsg, raw);
  const locationText = location?.line
    ? `Lokalizacja bledu: linia ${location.line}, kolumna ${location.column || "?"}.`
    : "Lokalizacja bledu: brak pewnej pozycji (napraw najblizszy uszkodzony fragment).";
  const context = buildJsonErrorContext(raw, location, 3);
  return `Poprzednia odpowiedz nie byla poprawnym pojedynczym JSON-em (parser ja odrzucil).
Blad parsera: ${errMsg}
${locationText}
Wskazowka: ${jsonRepairHintFromError(errMsg)}

Twoje zadanie: NAPRAW MINIMALNIE skladnie w istniejacym szkicu JSON — nie pisz odpowiedzi od zera.
Zachow ten sam "tool" i intencje "args" co w szkicu, jesli to mozliwe. Nie zmieniaj planu na inne narzedzie, chyba ze naprawa jest niemozliwa.
Jesli naprawa wymaga skrocenia: zwroc poprawny JSON z krotszym args (np. krotszy url albo mniejszy fragment content + dalsza praca w kolejnym kroku przez append).
Zmodyfikuj tylko uszkodzony fragment i zostaw pozostale pola bez zmian.

Odpowiedz WYLACZNIE jednym poprawnym JSON-em zgodnym z kontraktem systemowym — bez Markdown, bez tekstu przed/po, bez tablicy [...] (tylko obiekt {...}).
Jesli odzysk jest niemozliwy:
{"note":"odzysk po bledzie JSON","final":"Nie udalo sie bezpiecznie kontynuowac."}

Kontekst linii wokol bledu:
${context}

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
    patch_edit: ["path", "search", "replace", "count"],
    patch_batch: ["patch", "defaultPath", "blocks"],
    run_powershell: ["command", "timeout"],
    fetch_url: ["url", "timeout", "raw"],
    extract_media: ["url", "timeout"],
    download_file: ["url", "path"],
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
  const noteOnly = !hasFinal && !toolName && typeof parsed.note === "string" && parsed.note.trim() !== "";
  if (noteOnly) {
    // Treat clarification/notes as final user-facing question instead of hard-failing.
    return { ok: true, action: { ...parsed, final: parsed.note.trim() } };
  }
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
  let args = parsed.args !== undefined ? parsed.args : {};
  if (toolName === "fetch_url") {
    const rawUrl = String(args.url || "").trim();
    if (!rawUrl) {
      const query = compactWhitespace(String(args.query || args.search || args.q || "").trim());
      if (query) {
        args = { ...args, url: buildDuckDuckGoSearchUrl(query), timeout: args.timeout ?? 20, raw: args.raw ?? false };
      } else {
        return { ok: false, error: "Narzędzie fetch_url wymaga args.url (http/https) lub args.query do automatycznego wyszukania." };
      }
    } else if (!/^https?:\/\//i.test(rawUrl) && compactWhitespace(rawUrl)) {
      args = { ...args, url: buildDuckDuckGoSearchUrl(rawUrl), timeout: args.timeout ?? 20, raw: args.raw ?? false };
    }
  }
  const requiredPathTools = new Set(["write_file", "read_file", "patch_edit", "mkdir", "cd"]);
  if (requiredPathTools.has(toolName)) {
    const p = String(args.path || "").trim();
    if (!p || p === "." || p === "./") {
      return { ok: false, error: `Narzędzie ${toolName} wymaga poprawnego args.path wskazującego plik/folder (nie '.' ani pusty).` };
    }
  }
  return { ok: true, action: { ...parsed, tool: toolName, args } };
}

function makeActionSchemaRepairPrompt(schemaError, raw, options = {}) {
  const location = options.location || extractJsonErrorLocation(String(schemaError || ""), raw);
  const context = buildJsonErrorContext(raw, location, 3);
  return `Poprzednia odpowiedz miala poprawna skladnie JSON, ale narusza KONTRAKT akcji.
Blad: ${String(schemaError).slice(0, 500)}

Napraw KONTRAKT przy zachowaniu intencji: ten sam "tool" (jesli byl blisko poprawny) albo popraw nazwe na jedna z listy; uzupelnij "final" albo "tool"+"args".
Nie tworz nowego JSON od zera — popraw minimalnie istniejacy szkic.

Musisz zwrocic WYLACZNIE jeden obiekt JSON:
- albo koniec pracy: {"note":"...","final":"odpowiedz po polsku"}
- albo narzedzie: {"note":"...","tool":"NAZWA","args":{}}

Dozwolone wartosci "tool" (dokladnie te stringi): ${allowedToolNamesList()}

Nie uzywaj kluczy "name", "function" zamiast "tool". Nie zwracaj samego {"note":"..."} bez "final" ani bez "tool".
Nigdy nie zwracaj JSON jako tablicy [...] — tylko jeden obiekt {...}.
Jesli blad dotyczy zbyt dlugiego write_file w jednym kroku: zwroc krotszy poprawny write_file (overwrite lub append), reszte w nastepnych krokach.

Jesli blad mowi o braku "final" / pustym "final", a uzytkownik pytal o mozliwosci („co potrafisz” itd.): zwroc np.
{"note":"Mozliwosci agenta","final":"Pracuje w sandboxie plikow. Narzedzia: ${allowedToolNamesList()}. Odpowiadam po polsku."}

Jesli nie wiesz co dalej:
{"note":"odzysk","final":"Nie udalo sie zwrocic poprawnej akcji — sprobuj ponownie lub zmien zadanie."}

Kontekst linii wokol bledu:
${context}

Odrzucona odpowiedz (fragment):
${String(raw || "").slice(0, 1600)}`;
}

function getPreferredEditFormat(modelId = "", intentClass = "general") {
  const id = String(modelId || "").toLowerCase();
  if (intentClass !== "filesystem") return "json_action";
  if (/\bgpt-oss\b|\bdeepseek\b|\bqwen\b|\bcoder\b/.test(id)) return "search_replace";
  return "search_replace";
}

function buildFilesystemPatchFirstReminder() {
  return [
    "PATCH_FIRST_REMINDER",
    "Dla tego kroku preferuj Aider-style patch-first.",
    "Priorytet: patch_batch z blokami SEARCH/REPLACE albo patch_edit.",
    "Dla nowych plikow write_file jest OK.",
    "Dla istniejacych plikow preferuj patch_edit/patch_batch, ale gdy trzeba mozesz uzyc write_file.",
    "Mozesz zwrocic surowe bloki SEARCH/REPLACE bez JSON.",
  ].join("\n");
}

function enforceFilesystemPatchFirst(validatedAction) {
  const action = validatedAction?.action || null;
  if (!action || action.final) return null;
  return null;
}

async function getNextActionWithRepair(abortSignal, failedModelIds, step = null) {
  let actionRawReasoning = "";
  let lastError = null;
  let lastRaw = "";
  const retryLimit = Math.max(ACTION_REFLECTION_MIN, getJsonRepairRetryLimit());
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    if (attempt > 0) {
      bumpAgentRecoveryMetric("repairAttempts");
      emit("status", {
        status: "action-schema-retry",
        detail: `Naprawiam format akcji (${attempt}/${retryLimit}).`,
      });
    }
    let promptMessages = agentCore?.memory
      ? [...createInitialMessages(), ...agentCore.memory.getModelContext()]
      : messages;
    const model = getModelConfig();
    const modelSettings = getModelSettingsForId(model?.id || selectedModelId);
    const preferredEditFormat = getPreferredEditFormat(model?.id || selectedModelId, currentAgentIntentClass);
    const contextTokensLimit = clampContextTokens(modelSettings.contextTokens ?? model?.contextTokens ?? 8192);
    const plannerPromptLimit = Math.max(MIN_CONTEXT_TOKENS, Math.floor(contextTokensLimit * 0.78));
    if (estimateTokens(promptMessages) > plannerPromptLimit && promptMessages.length > 3) {
      const head = promptMessages[0];
      const tail = promptMessages.slice(-6).map((msg, index, arr) => {
        const isLatest = index === arr.length - 1;
        const maxChars = isLatest ? 2600 : 1200;
        return shrinkRetainedMessageForCompaction(msg, maxChars);
      });
      promptMessages = [head, ...tail];
    }
    if (preferredEditFormat === "search_replace") {
      promptMessages = [
        ...promptMessages,
        { role: "user", content: buildFilesystemPatchFirstReminder() },
      ];
    }
    const { content: raw, reasoning } = await callModelWithRecovery(promptMessages, abortSignal, failedModelIds, {}, step);
    lastRaw = String(raw || "");
    if (reasoning) actionRawReasoning = reasoning;
    emit("model-raw", { raw });
    let parsed;
    try {
      parsed = parseActionEnvelope(raw);
    } catch (error) {
      lastError = error;
      bumpAgentRecoveryMetric("parseErrors");
      const recoveredFromBlocks = recoverActionFromSearchReplaceBlocks(raw);
      if (recoveredFromBlocks) {
        const recoveredValidation = validateAction(recoveredFromBlocks, {
          intentClass: currentAgentIntentClass,
        });
        if (recoveredValidation.ok) {
          bumpAgentRecoveryMetric("naturalTextRecoveries");
          emit("status", {
            status: "action-auto-recover",
            detail: "Model zwrocil surowe bloki SEARCH/REPLACE; zastosowano konwersje do patch_batch.",
            step,
          });
          return { action: recoveredValidation.action, reasoning: actionRawReasoning };
        }
      }
      const recovered = recoverActionFromNaturalText(raw, {
        intentClass: currentAgentIntentClass,
        userPrompt: currentAgentUserPrompt,
      });
      if (recovered) {
        const recoveredValidation = validateAction(recovered, {
          intentClass: currentAgentIntentClass,
        });
        if (recoveredValidation.ok) {
          bumpAgentRecoveryMetric("naturalTextRecoveries");
          emit("status", {
            status: "action-auto-recover",
            detail: "Model zwrocil prose; zastosowano awaryjna konwersje do poprawnej akcji JSON.",
            step,
          });
          return { action: recoveredValidation.action, reasoning: actionRawReasoning };
        }
      }
      const partial = parsePartialActionFromRaw(raw);
      if (partial) {
        const partialValidation = validateAction(partial, {
          intentClass: currentAgentIntentClass,
        });
        if (partialValidation.ok) {
          bumpAgentRecoveryMetric("partialJsonRecoveries");
          emit("status", {
            status: "action-partial-json-recover",
            detail: "Odzyskano obciety JSON akcji z odpowiedzi modelu.",
            step,
          });
          return { action: partialValidation.action, reasoning: actionRawReasoning };
        }
      }
      if (attempt >= retryLimit) break;
      const guidance = makeJsonRepairPrompt(error, raw, { step, attempt, retryLimit });
      if (agentCore?.memory) {
        agentCore.memory.append("assistant", `Format error: ${error.message}`);
        agentCore.memory.append("user", guidance);
      }
      continue;
    }
    const validated = validateAction(parsed, {
      intentClass: currentAgentIntentClass,
    });
    if (!validated.ok) {
      lastError = new Error(validated.error || "action validation failed");
      bumpAgentRecoveryMetric("schemaErrors");
      if (attempt >= retryLimit) break;
      const guidance = makeActionSchemaRepairPrompt(
        `${validated.errorCode || "invalid_action"} ${validated.error || ""}`.trim(),
        raw,
        { step, attempt, retryLimit },
      );
      if (agentCore?.memory) {
        agentCore.memory.append("assistant", `Schema error: ${validated.errorCode || "invalid_action"} ${validated.error}`);
        agentCore.memory.append("user", guidance);
      }
      continue;
    }
    if (currentAgentIntentClass === "filesystem") {
      const patchFirstGate = enforceFilesystemPatchFirst(validated);
      if (patchFirstGate) {
        lastError = new Error(patchFirstGate.error);
        bumpAgentRecoveryMetric("schemaErrors");
        if (attempt >= retryLimit) break;
        const guidance = makeActionSchemaRepairPrompt(
          `${patchFirstGate.errorCode} ${patchFirstGate.error}`.trim(),
          raw,
          { step, attempt, retryLimit },
        );
        if (agentCore?.memory) {
          agentCore.memory.append("assistant", `Schema error: ${patchFirstGate.errorCode} ${patchFirstGate.error}`);
          agentCore.memory.append("user", guidance);
        }
        continue;
      }
    }
    return { action: validated.action, reasoning: actionRawReasoning };
  }
  throw new Error(`Model zwrocil niepoprawny format akcji po ${retryLimit + 1} probach: ${lastError?.message || String(lastRaw || "nieznany blad")}`);
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

function inferBackendFromRuntimeBinaries(serverExePath = "") {
  try {
    const dir = path.dirname(String(serverExePath || ""));
    if (!dir || !fs.existsSync(dir)) return "unknown";
    if (fs.existsSync(path.join(dir, "ggml-cuda.dll"))) return "cuda";
    if (fs.existsSync(path.join(dir, "ggml-vulkan.dll"))) return "vulkan";
    return "cpu";
  } catch {
    return "unknown";
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
  if (tool === "write_file" || tool === "patch_edit" || tool === "patch_batch") {
    return "Jesli zapis nie jest mozliwy (np. tekst za dlugi), zacznij od nowa zapisujac partiami przez mode 'append' w konkretnych miejscach. Jesli to nowy skrypt, sprawdz potem przez run_powershell czy sie wykonuje/otwiera poprawnie. W ostatecznosci utworz plik obok w exports/.";
  }
  if (/Nieznane narzedzie|undefined/i.test(message)) {
    return "Uzyto zlego lub nieistniejacego (undefined) narzedzia. Zmien na poprawne narzedzie z listy 'Dostepne narzedzia'.";
  }
  if (tool === "run_powershell") {
    if (/SyntaxError|Unexpected token|Unexpected end|Expected .* after|missing \)|missing \}|unterminated/i.test(message)) {
      return "To blad skladni w konkretnym pliku, nie powod do przepisywania projektu. Odczytaj stack trace/linie, read_file okolicy bledu, popraw minimalny fragment przez patch_edit, potem uruchom ten sam check ponownie.";
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

function getShellPolicyWarnings(command = "") {
  const cmd = String(command || "");
  const warnings = [];
  for (const item of blockedShellPatterns) {
    if (item.re.test(cmd)) warnings.push(item.reason);
  }
  return [...new Set(warnings)];
}

async function runPowerShell(command, timeoutSeconds) {
  const policyWarnings = getShellPolicyWarnings(command);
  const commandForApproval = policyWarnings.length
    ? `${command}\n\n[Ostrzezenia sandbox]\n- ${policyWarnings.join("\n- ")}\nUruchomic mimo ostrzezen?`
    : command;
  const approved = await askApproval({
    title: policyWarnings.length
      ? "Model prosi o uruchomienie komendy (ostrzezenia sandbox)"
      : "Model prosi o uruchomienie komendy",
    cwd: relativeToRoot(cwd),
    command: commandForApproval,
  });
  if (!approved) throw new Error("Uzytkownik odrzucil komende.");

  return new Promise((resolve) => {
    const timeout = Math.max(1, Math.min(Number(timeoutSeconds) || 60, 300)) * 1000;
    const child = spawn(command, {
      cwd,
      shell: true,
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
    let settled = false;
    const finalize = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      child.kill();
      stderr += "\n[timeout]";
    }, timeout);
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (err) => {
      stderr += `\n[spawn-error] ${err?.message || String(err)}`;
      finalize({
        cwd: relativeToRoot(cwd),
        exitCode: 1,
        stdout: textPreview(stdout),
        stderr: textPreview(stderr),
      });
    });
    child.on("close", (code) => {
      finalize({
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

const CHAT_SYSTEM_PROMPT = `Jestes pomocnym asystentem w trybie CZATU (bez akcji narzedziowych i bez edycji plikow).
Odpowiadaj po polsku, konkretnie i naturalnie.
W tym trybie mozesz dostac blok "Kontekst z internetu". Traktuj go jako aktualne dane i samodzielnie decyduj, jak mocno na nim oprzec odpowiedz.
Jesli danych jest za malo, odpowiedz uczciwie i zaznacz niepewnosc zamiast zgadywac.
Nie wymyslaj adresow URL ani danych firmowych (telefony, ceny, oferty, adresy, maile), jesli nie wynikaja z kontekstu.
Jesli korzystasz z danych internetowych, dodaj na koncu krotka sekcje "Źródła:" z URL-ami, ktorych faktycznie uzyles.
Nie zwracaj JSON ani pseudo-wywolan narzedzi.`;

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

function appendSourcesSection(text, sourceUrls = []) {
  const body = String(text || "").trim();
  const urls = [...new Set((Array.isArray(sourceUrls) ? sourceUrls : []).map((url) => String(url || "").trim()).filter((url) => /^https?:\/\//i.test(url)))].slice(0, 12);
  if (!urls.length) return body;
  if (/^zrodla\s*:|^źródła\s*:/im.test(body)) return body;
  return `${body}\n\nŹródła:\n${urls.map((url) => `- ${url}`).join("\n")}`;
}

function replaceByExactMatch(content, search, replace, count = 1) {
  const occurrences = content.split(search).length - 1;
  if (!occurrences) return null;
  if (count < 0) return { updated: content.split(search).join(replace), replaced: occurrences, strategy: "exact_all" };
  let remaining = count;
  const updated = content.replaceAll(search, () => {
    if (remaining <= 0) return search;
    remaining -= 1;
    return replace;
  });
  return { updated, replaced: Math.min(occurrences, count), strategy: "exact" };
}

function replaceByRelativeIndent(content, search, replace, count = 1) {
  const contentLines = String(content).replace(/\r\n/g, "\n").split("\n");
  const searchLines = String(search).replace(/\r\n/g, "\n").split("\n");
  const replaceLines = String(replace).replace(/\r\n/g, "\n").split("\n");
  if (!searchLines.length || !contentLines.length || searchLines.length > contentLines.length) return null;

  const normalizedSearch = searchLines.map((line) => line.trimStart());
  let replaced = 0;
  for (let start = 0; start <= contentLines.length - searchLines.length; start += 1) {
    const windowLines = contentLines.slice(start, start + searchLines.length);
    const normalizedWindow = windowLines.map((line) => line.trimStart());
    let match = true;
    for (let i = 0; i < normalizedSearch.length; i += 1) {
      if (normalizedSearch[i] !== normalizedWindow[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const indents = windowLines
      .filter((line) => line.trim().length > 0)
      .map((line) => (line.match(/^\s*/)?.[0] || "").length);
    const minIndent = indents.length ? Math.min(...indents) : 0;
    const indentPrefix = " ".repeat(minIndent);
    const adaptedReplace = replaceLines.map((line) => {
      if (!line.trim()) return line;
      return `${indentPrefix}${line.trimStart()}`;
    });
    const before = contentLines.slice(0, start);
    const after = contentLines.slice(start + searchLines.length);
    const updatedLines = [...before, ...adaptedReplace, ...after];
    replaced += 1;
    const updated = updatedLines.join("\n");
    if (replaced >= Math.max(1, count)) {
      return { updated, replaced, strategy: "relative_indent" };
    }
  }
  return null;
}

function replaceByDotDotDots(content, search, replace, count = 1) {
  const s = String(search);
  const r = String(replace);
  if (!s.includes("\n...\n")) return null;
  const sParts = s.split(/\n\.\.\.\n/g);
  const rParts = r.split(/\n\.\.\.\n/g);
  if (sParts.length !== rParts.length) return null;
  let updated = String(content);
  let replaced = 0;
  for (let i = 0; i < sParts.length; i += 1) {
    const sPart = sParts[i];
    const rPart = rParts[i];
    if (!sPart.trim() && !rPart.trim()) continue;
    const exact = replaceByExactMatch(updated, sPart, rPart, 1);
    if (!exact) return null;
    updated = exact.updated;
    replaced += 1;
    if (replaced >= Math.max(1, count)) break;
  }
  if (!replaced) return null;
  return { updated, replaced, strategy: "dotdotdot_segments" };
}

function applyPatchStyleSearchReplace(content, search, replace, count = 1) {
  const exact = replaceByExactMatch(content, search, replace, count);
  if (exact) return exact;
  const lfNormalized = replaceByExactMatch(
    String(content).replace(/\r\n/g, "\n"),
    String(search).replace(/\r\n/g, "\n"),
    String(replace).replace(/\r\n/g, "\n"),
    count,
  );
  if (lfNormalized) return { ...lfNormalized, strategy: "exact_lf_normalized" };
  const relativeIndent = replaceByRelativeIndent(content, search, replace, count);
  if (relativeIndent) return relativeIndent;
  const dotDotDots = replaceByDotDotDots(content, search, replace, count);
  if (dotDotDots) return dotDotDots;
  return null;
}

function parsePatchBatchText(patchText = "", defaultPath = "") {
  const lines = String(patchText || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let idx = 0;
  let currentPath = String(defaultPath || "").trim();
  while (idx < lines.length) {
    const line = lines[idx];
    if (!line) {
      idx += 1;
      continue;
    }
    if (line.trim() === "<<<<<<< SEARCH") {
      if (!currentPath) throw new Error("Brak sciezki pliku przed blokiem SEARCH/REPLACE.");
      idx += 1;
      const searchLines = [];
      while (idx < lines.length && lines[idx].trim() !== "=======") {
        searchLines.push(lines[idx]);
        idx += 1;
      }
      if (idx >= lines.length) throw new Error("Brak separatora ======= w bloku SEARCH/REPLACE.");
      idx += 1;
      const replaceLines = [];
      while (idx < lines.length && lines[idx].trim() !== ">>>>>>> REPLACE") {
        replaceLines.push(lines[idx]);
        idx += 1;
      }
      if (idx >= lines.length) throw new Error("Brak znacznika >>>>>>> REPLACE w bloku SEARCH/REPLACE.");
      blocks.push({
        path: currentPath,
        search: searchLines.join("\n"),
        replace: replaceLines.join("\n"),
      });
      idx += 1;
      continue;
    }
    if (!line.trim().startsWith("```") && !line.includes("<<<<<<< SEARCH")) {
      currentPath = line.trim().replace(/:$/, "");
    }
    idx += 1;
  }
  return blocks;
}

function recoverActionFromSearchReplaceBlocks(raw) {
  const text = String(raw || "").trim();
  if (!text || !text.includes("<<<<<<< SEARCH") || !text.includes(">>>>>>> REPLACE")) return null;
  try {
    const blocks = parsePatchBatchText(text, "");
    if (!Array.isArray(blocks) || !blocks.length) return null;
    return {
      note: "Auto-recover: parsed SEARCH/REPLACE blocks into patch_batch action.",
      tool: "patch_batch",
      args: { blocks },
    };
  } catch {
    return null;
  }
}

function isSuspiciousStatusOverwrite(targetPath, content, mode = "overwrite") {
  if (String(mode || "overwrite") === "append") return false;
  const ext = path.extname(String(targetPath || "")).toLowerCase();
  const guardedExts = new Set([
    ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".json", ".md", ".py", ".java", ".go", ".rs", ".php", ".rb", ".c", ".cpp", ".h", ".hpp",
  ]);
  if (!guardedExts.has(ext)) return false;
  const text = String(content ?? "").trim();
  if (!text) return false;
  const shortish = text.length <= 220;
  const lowLineCount = text.split(/\r?\n/).length <= 4;
  const noCodeMarkers = !/[<>{}[\];=]/.test(text) && !/\b(function|class|import|export|const|let|var|def|SELECT|INSERT)\b/i.test(text);
  const looksLikeStatus = /\b(zapisano|gotowe|pomyslnie|pomyślnie|utworzono|zaktualizowano|wykonano|all done|done|saved)\b/i.test(text);
  return shortish && lowLineCount && noCodeMarkers && looksLikeStatus;
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
    if (isSuspiciousStatusOverwrite(target, args.content, args.mode)) {
      throw new Error(
        "Odrzucono podejrzany overwrite: tresc wyglada jak komunikat statusu modelu, a nie zawartosc pliku. Zakoncz przez final zamiast zapisywac komunikat do pliku.",
      );
    }
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
  } else if (tool === "patch_edit") {
    const target = normalizeInsideRoot(args.path);
    const before = await fsp.readFile(target, "utf8");
    const oldText = String(args.search ?? "");
    const newText = String(args.replace ?? "");
    if (!oldText) throw new Error("search nie moze byc puste.");
    const count = Number.isInteger(Number(args.count)) ? Number(args.count) : 1;
    const patched = applyPatchStyleSearchReplace(before, oldText, newText, count);
    if (!patched) throw new Error(`SEARCH_REPLACE_NO_EXACT_MATCH path=${relativeToRoot(target)} :: SEARCH block failed to exactly match lines w pliku.`);
    const after = patched.updated;
    await fsp.writeFile(target, after, "utf8");
    result = { path: relativeToRoot(target), replaced: patched.replaced, strategy: patched.strategy };
    emit("file-change", {
      path: relativeToRoot(target),
      action: "patch_edit",
      diff: makeLineDiff(before, after),
      before: textPreview(before),
      after: textPreview(after),
    });
  } else if (tool === "patch_batch") {
    const blocks = Array.isArray(args.blocks) && args.blocks.length
      ? args.blocks.map((block) => ({
        path: String(block?.path || args.defaultPath || "").trim(),
        search: String(block?.search ?? ""),
        replace: String(block?.replace ?? ""),
      }))
      : parsePatchBatchText(String(args.patch || ""), String(args.defaultPath || ""));
    if (!blocks.length) throw new Error("Brak blokow SEARCH/REPLACE do zastosowania.");
    const applied = [];
    for (const block of blocks) {
      if (!block.path) throw new Error("Blok SEARCH/REPLACE nie ma poprawnej sciezki pliku.");
      const target = normalizeInsideRoot(block.path);
      const before = await fsp.readFile(target, "utf8");
      const patched = applyPatchStyleSearchReplace(before, block.search, block.replace, 1);
      if (!patched) {
        throw new Error(
          `SEARCH_REPLACE_NO_EXACT_MATCH path=${block.path} :: SEARCH block failed to exactly match lines w pliku ${block.path}. Uzyj read_file i podaj dokladny fragment SEARCH.`,
        );
      }
      const after = patched.updated;
      await fsp.writeFile(target, after, "utf8");
      applied.push({ path: relativeToRoot(target), strategy: patched.strategy });
      emit("file-change", {
        path: relativeToRoot(target),
        action: "patch_edit",
        diff: makeLineDiff(before, after),
        before: textPreview(before),
        after: textPreview(after),
      });
    }
    result = { appliedCount: applied.length, applied };
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
  } else {
    throw new Error(`Wewnetrzny blad: brak implementacji narzedzia ${tool}.`);
  }

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

// Vision support removed.

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

function getAgentCore() {
  if (!agentCore) {
    const memory = createSessionMemory({
      maxTaskMessages: 8,
      summarize: (batch) => batch.map(summarizeMessageForCompaction).join("\n"),
      detectIntentKey: (text) => compactWhitespace(String(text || "")).toLowerCase().slice(0, 220),
      shouldResetOnIntentChange: (_currentKey, _nextKey, userText) => {
        const text = String(userText || "").toLowerCase();
        return /\b(nowe zadanie|od nowa|zresetuj|reset kontekstu|zacznij od zera|new task|start over)\b/.test(text);
      },
    });
    const planner = createAgentPlanner({
      nextAction: getNextActionWithRepair,
      getRepeatLimit: getActionRepeatLimit,
      signatureForAction: actionSignature,
    });
    const toolExecutor = createToolExecutor({
      executeTool,
      onToolResult: (payload) => emit("tool-result", payload),
      validateAction: (action) => validateAction(action, { intentClass: currentAgentIntentClass }),
    });
    const orchestrator = createTurnOrchestrator({
      planner,
      toolExecutor,
      memory,
      emit,
      compactMessages,
      appendSourcesSection,
      buildRepeatedActionBlock,
      onRecoverableError: async ({ step, action, toolPayload }) => {
        if (!agentCore?.memory) return;
        bumpAgentRecoveryMetric("toolErrors");
        const repairHint = buildMachineRepairPrompt(
          { errorCode: toolPayload?.errorCode || "tool_error", error: toolPayload?.error || "Tool failed." },
          JSON.stringify(action || {}),
        );
        emit("status", {
          status: "action-recover",
          detail: `Recovery step ${step}: ${String(toolPayload?.error || "tool error").slice(0, 160)}`,
        });
        agentCore.memory.append("assistant", `Execution failed: ${toolPayload?.error || "unknown error"}`);
        agentCore.memory.append("user", repairHint);
      },
    });
    agentCore = { memory, planner, toolExecutor, orchestrator };
  }
  return agentCore;
}

async function runAgent(userText) {
  if (runInProgress) throw new Error("Agent juz pracuje.");
  runInProgress = true;
  runAbortController = new AbortController();
  const startedAt = Date.now();
  const signal = runAbortController.signal;
  try {
    resetAgentRecoveryMetrics();
    await validateCurrentWorkspaceRoot();
    await ensureServer(DEFAULT_PORT);
    const core = getAgentCore();

    let content;
    if (typeof userText === "object" && userText !== null && userText.imageBase64) {
      throw new Error("Obrazy/Vision zostaly usuniete z aplikacji.");
    } else if (typeof userText === "object" && userText !== null && userText.attachment) {
      const text = String(userText.text || "").trim();
      const attachment = userText.attachment;
      emit("run-start", { text: text || `[Załączono plik: ${attachment?.name || "plik"}]` });
      const extracted = await extractAttachmentText(attachment);
      content = extracted.ok
        ? `${text || "Przeanalizuj załączony plik."}\n\nAttachment: ${extracted.name}\n${extracted.text}`
        : `${text || "Przeanalizuj załączony plik."}\n\nAttachment read error: ${extracted.reason}`;
    } else {
      content = String(userText || "");
      emit("run-start", { text: content });
    }
    currentAgentIntentClass = classifyIntent(content);
    currentAgentUserPrompt = content;
    emit("agent-phase", { phase: "understand", intentClass: currentAgentIntentClass });
    messages.push({ role: "user", content });

    const model = getModelConfig();
    const modelSettings = getModelSettingsForId(model?.id || selectedModelId);
    const reasoning = getReasoningProfile();
    const effectiveMaxSteps = modelSettings.maxSteps === 0 ? 999999 : (modelSettings.maxSteps ?? reasoning.maxSteps);
    const failedModelIds = new Set();
    const result = await core.orchestrator.runTurn({
      signal,
      userContent: content,
      maxSteps: effectiveMaxSteps,
      failedModelIds,
    });
    const finalText = String(result?.final || "");
    const quickChoices = buildQuickChoicesForFinal(finalText, currentAgentIntentClass, agentRecoveryMetrics);
    emit("final", { text: finalText });
    if (quickChoices) emit("quick-choices", quickChoices);
    messages.push({ role: "assistant", content: JSON.stringify({ final: finalText }) });
    baselineMetrics.recordRun({ mode: "agent", latencyMs: Date.now() - startedAt, ok: true, backend: runtimeBackendStatus.activeBackend });
    return { ok: true, final: finalText };
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
    baselineMetrics.recordRun({ mode: "agent", latencyMs: Date.now() - startedAt, ok: false, backend: runtimeBackendStatus.activeBackend });
    return { ok: false, error: message };
  } finally {
    runInProgress = false;
    runAbortController = null;
    emit("agent-recovery-metrics", { ...agentRecoveryMetrics });
    emit("run-end", { recoveryMetrics: { ...agentRecoveryMetrics } });
  }
}

async function dispatchUserRequest(payload) {
  // Unified autonomous mode: model plans and executes in one pipeline.
  return runAgent(payload);
}

function processRunQueue() {
  if (runQueueActive) return;
  if (!runQueue.length) return;
  runQueueActive = true;
  const item = runQueue.shift();
  const queueSize = runQueue.length;
  emit("status", {
    status: "queue-processing",
    detail: queueSize > 0 ? `Przetwarzam zadanie z kolejki. Pozostalo: ${queueSize}.` : "Przetwarzam zadanie.",
  });
  dispatchUserRequest(item.payload)
    .then(item.resolve)
    .catch(item.reject)
    .finally(() => {
      runQueueActive = false;
      processRunQueue();
    });
}

function enqueueUserRequest(payload) {
  return new Promise((resolve, reject) => {
    runQueue.push({ payload, resolve, reject });
    const pos = runQueue.length;
    if (pos > 1 || runQueueActive) {
      emit("status", {
        status: "queue-enqueued",
        detail: `Dodano zadanie do kolejki (pozycja ${pos}).`,
      });
    }
    processRunQueue();
  });
}

async function runSimpleChat(userText) {
  if (runInProgress) throw new Error("Agent juz pracuje.");
  runInProgress = true;
  runAbortController = new AbortController();
  const startedAt = Date.now();
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
    const modelLookupQuery = await deriveLookupQueryWithModel(text, history, signal);
    let webLookup = null;
    if (modelLookupQuery) {
      emit("chat-web-lookup", {
        phase: "start",
        query: text,
        lookupQuery: modelLookupQuery,
        detail: "Model zdecydowal, ze potrzebny jest web lookup.",
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
      chatMessages.splice(2, 0, { role: "user", content: buildWebConfidenceInstruction(webLookup) });
      emit("status", { status: "model-thinking", detail: "Czat: dolaczono lekki kontekst internetowy." });
      const sourceUrls = Array.isArray(webLookup.sources)
        ? webLookup.sources.map((source) => String(source?.url || "").trim()).filter(Boolean).slice(0, 6)
        : [];
      if (sourceUrls.length) {
        chatMessages.splice(3, 0, {
          role: "user",
          content: `Dostepne zrodla URL z tej tury:\n${sourceUrls.map((url) => `- ${url}`).join("\n")}`,
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
        quality: webLookup.quality || null,
        sourceDiagnostics: Array.isArray(webLookup.sourceDiagnostics) ? webLookup.sourceDiagnostics.slice(0, 8) : [],
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
        quality: webLookup?.quality || null,
        sourceDiagnostics: Array.isArray(webLookup?.sourceDiagnostics) ? webLookup.sourceDiagnostics.slice(0, 8) : [],
        detail: webLookup?.skipped ? "Pominięto web lookup dla krótkiego/nieadekwatnego zapytania." : "Brak trafnego kontekstu internetowego.",
      });
      chatMessages.splice(1, 0, { role: "user", content: "Lookup sieciowy nie dal mocnego kontekstu. Odpowiedz uczciwie: co wiadomo i czego nie udalo sie potwierdzic." });
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

    if (webLookup?.sources?.length) {
      const usedUrls = webLookup.sources.map((entry) => String(entry?.url || "").trim()).filter(Boolean).slice(0, 8);
      reply = appendSourcesSection(reply, usedUrls);
    }
    messages.push({ role: "user", content: text });
    messages.push({ role: "assistant", content: reply });
    emit("final", { text: reply, chatMode: true });
    baselineMetrics.recordRun({ mode: "chat", latencyMs: Date.now() - startedAt, ok: true, backend: runtimeBackendStatus.activeBackend });
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
    baselineMetrics.recordRun({ mode: "chat", latencyMs: Date.now() - startedAt, ok: false, backend: runtimeBackendStatus.activeBackend });
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
    appHome: ENDOCODE_HOME,
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
      backend: runtimeBackendStatus.activeBackend,
      expectedBackend: runtimeBackendStatus.expectedBackend,
      backendValidation: runtimeBackendStatus.validation,
      backendDetail: runtimeBackendStatus.detail,
      backendCheckedAt: runtimeBackendStatus.lastCheckedAt,
    },
    baselineMetrics: baselineMetrics.getSummary(),
    instructionPolicy: instructionPolicyMeta,
    port: DEFAULT_PORT,
    customModelSettings: modelSettings,
    customModelSettingsByModelId,
    maxMessages: getActiveMaxMessages(),
    agentRuntime,
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
  if (settings.agentRuntime === "legacy" || settings.agentRuntime === "v2") {
    agentRuntime = settings.agentRuntime;
  }
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
  if (agentCore?.memory) agentCore.memory.hardReset("");
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
  if (agentCore?.memory) agentCore.memory.hardReset("");
  if (serverOwned) await stopOwnedServer();
  emit("status", { status: "model-selected", detail: `Wybrano model: ${model.displayName}` });
  return getState();
});
ipcMain.handle("app:set-reasoning", (_event, level) => {
  if (!REASONING_LEVELS[level]) throw new Error(`Nieznana intensywnosc: ${level}`);
  selectedReasoning = level;
  saveAppSettings();
  messages = createInitialMessages();
  if (agentCore?.memory) agentCore.memory.hardReset("");
  emit("status", { status: "reasoning-selected", detail: `Intensywnosc: ${REASONING_LEVELS[level].label}` });
  return getState();
});
registerAgentIpcHandlers(ipcMain, {
  runAgent: (payload) => enqueueUserRequest(payload),
  runSimpleChat: (text) => enqueueUserRequest(text),
  abortRun: () => {
    if (runAbortController) {
      runAbortController.abort();
      return { aborted: true };
    }
    if (runQueue.length) {
      while (runQueue.length) {
        const pending = runQueue.shift();
        pending?.reject?.(new Error("Anulowano zadanie z kolejki."));
      }
      return { aborted: true, clearedQueue: true };
    }
    return { aborted: false };
  },
  killServer: () => killModelServerResources(),
  approvalReply: (_event, approvalId, approved) => {
    ipcMain.emit(`approval:${approvalId}`, _event, approved);
    return { ok: true };
  },
});
ipcMain.handle("app:system-info", () => {
  const startedAt = Date.now();
  const info = getSystemInfo();
  logPerf("app:system-info", startedAt);
  return {
    ...info,
    runtimeBackend: runtimeBackendStatus.activeBackend,
    runtimeBackendValidation: runtimeBackendStatus.validation,
  };
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

  const dest = path.resolve(ENDOCODE_HOME, model.file);
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
  
  const filePath = path.resolve(ENDOCODE_HOME, model.file);
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
  const tokenLimits = getTokenRuntimeLimits();
  const contextTokens = clampContextTokens(selected.contextTokens ?? model?.contextTokens ?? 8192, tokenLimits);
  return {
    temperature: selected.temperature ?? getReasoningProfile().temperature,
    maxTokens: clampResponseTokens(selected.maxTokens ?? getReasoningProfile().maxTokens, tokenLimits),
    maxSteps: selected.maxSteps ?? getReasoningProfile().maxSteps,
    topP: selected.topP ?? null,
    topK: selected.topK ?? null,
    repeatPenalty: selected.repeatPenalty ?? null,
    contextTokens,
    gpuLayers: selected.gpuLayers ?? model?.gpuLayers ?? 99,
    maxMessages: clampMaxMessages(selected.maxMessages ?? model?.maxMessages ?? 32, tokenLimits),
    threads: selected.threads ?? model?.threads ?? null,
    threadsBatch: selected.threadsBatch ?? model?.threadsBatch ?? null,
    batchSize: selected.batchSize ?? model?.batchSize ?? null,
    ubatchSize: selected.ubatchSize ?? model?.ubatchSize ?? null,
    parallel: selected.parallel ?? model?.parallel ?? null,
    flashAttention: selected.flashAttention ?? model?.flashAttention ?? null,
    cacheTypeK: selected.cacheTypeK ?? model?.cacheTypeK ?? null,
    cacheTypeV: selected.cacheTypeV ?? model?.cacheTypeV ?? null,
    reasoning: selected.reasoning ?? model?.reasoning ?? null,
    reasoningBudget: selected.reasoningBudget == null ? (model?.reasoningBudget ?? null) : clampReasoningBudget(selected.reasoningBudget, tokenLimits),
    extraServerArgs: selected.extraServerArgs ?? model?.extraServerArgs ?? [],
  };
}

function sanitizeSettingsPatch(rawSettings = {}) {
  const patch = {};
  for (const [key, value] of Object.entries(rawSettings || {})) {
    if (!MODEL_RUNTIME_WHITELIST.has(key)) continue;
    patch[key] = value;
  }
  const tokenLimits = getTokenRuntimeLimits();
  if (patch.contextTokens != null) patch.contextTokens = clampContextTokens(patch.contextTokens, tokenLimits);
  if (patch.maxTokens != null) patch.maxTokens = clampResponseTokens(patch.maxTokens, tokenLimits);
  if (patch.maxMessages != null) patch.maxMessages = clampMaxMessages(patch.maxMessages, tokenLimits);
  if (patch.reasoningBudget != null) patch.reasoningBudget = clampReasoningBudget(patch.reasoningBudget, tokenLimits);
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
  const tokenLimits = getTokenRuntimeLimits();
  return {
    modelId: targetModelId,
    modelName: model.displayName,
    _limits: tokenLimits,
    ...getModelSettingsForId(targetModelId),
    _effective: getEffectiveSettingsForModel(targetModelId),
  };
});

ipcMain.handle("app:get-model-recommended-settings", (_event, modelId) => {
  const targetModelId = String(modelId || selectedModelId);
  const model = loadModelCatalog().models.find((entry) => entry.id === targetModelId);
  if (!model) throw new Error(`Nieznany model: ${targetModelId}`);
  return {
    modelId: targetModelId,
    modelName: model.displayName,
    settings: getRecommendedSettingsForModelId(targetModelId),
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
