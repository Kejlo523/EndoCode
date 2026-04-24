const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawn, execSync } = require("node:child_process");
const crypto = require("node:crypto");
const os = require("node:os");

const DEFAULT_PORT = 8088;
const MAX_FILE_BYTES = 220000;
const MAX_MESSAGES = 32;

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
- read_file {"path":"plik","maxBytes":30000}
- write_file {"path":"plik","content":"...","mode":"overwrite albo append"}
- mkdir {"path":"folder"}
- replace_text {"path":"plik","old":"tekst","new":"tekst","count":1}
- run_powershell {"command":"npm test","timeout":60}

Gdy konczysz:
{"note":"krotkie podsumowanie toku pracy","final":"odpowiedz po polsku"}

Zasady:
- Nie probuj obchodzic sandboxa ani prosic o sciezki spoza root.
- Przed edycja czytaj plik, chyba ze go tworzysz.
- Komend shell uzywaj oszczednie; UI poprosi uzytkownika o zatwierdzenie.
- Note ma byc publiczna i krotka: plan, hipoteza albo decyzja, bez dlugiego ukrytego rozumowania.`;

let mainWindow;
let serverProcess = null;
let serverOwned = false;
let runningModelId = null;
let runInProgress = false;
let runAbortController = null;
let accessLevel = "sandbox"; // "sandbox" or "full"
let chatHistory = [];
let currentChatId = null;
let previousCpuInfo = os.cpus();

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
let workspaceRoot = path.join(BIELIK_HOME, "workspace");
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
  try {
    const out = execSync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits', { timeout: 2000, windowsHide: true }).toString().trim();
    gpuPercent = parseInt(out, 10) || 0;
  } catch { /* no nvidia-smi */ }

  return {
    cpu: cpuPercent,
    gpu: gpuPercent,
    ramPercent,
    ramUsedGB: (usedMem / 1073741824).toFixed(1),
    ramTotalGB: (totalMem / 1073741824).toFixed(1),
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

const initialSettings = loadAppSettings();
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
  return `${BASE_SYSTEM_PROMPT}

Aktualny model: ${model.displayName || model.id}.
Intensywnosc pracy: ${reasoning.label}.
Instrukcja intensywnosci: ${reasoning.instruction}`;
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

async function ensureWorkspaceRoot(root) {
  workspaceRoot = path.resolve(root);
  await fsp.mkdir(workspaceRoot, { recursive: true });
  cwd = workspaceRoot;
  return getState();
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

  const serverExe = getRuntimeServerExe();
  const modelPath = getModelPath();
  if (!serverExe) throw new Error("Nie znaleziono runtime/llama-server.exe.");
  const fileStatus = getModelFileStatus(config);
  if (!fileStatus.available) {
    const percent = Math.round((fileStatus.progress || 0) * 100);
    throw new Error(`Model nie jest jeszcze gotowy: ${config.displayName} (${percent}%).`);
  }

  await fsp.mkdir(path.join(BIELIK_HOME, "logs"), { recursive: true });
  const outLog = fs.openSync(path.join(BIELIK_HOME, "logs", "local-codex-server.out.log"), "a");
  const errLog = fs.openSync(path.join(BIELIK_HOME, "logs", "local-codex-server.err.log"), "a");

  emit("status", { status: "server-starting", detail: `Uruchamiam: ${config.displayName}.` });
  const serverArgs = [
    "-m", modelPath,
    "-c", String(config.contextTokens || 8192),
    "-ngl", String(config.gpuLayers ?? 99),
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

  const child = spawn(serverExe, serverArgs, {
    cwd: path.dirname(serverExe),
    stdio: ["ignore", outLog, errLog],
    windowsHide: true,
  });
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

async function stopOwnedServer() {
  if (serverProcess && serverOwned) {
    emit("status", { status: "server-stopping", detail: "Zatrzymuje lokalny serwer." });
    serverProcess.kill();
    serverProcess = null;
    serverOwned = false;
    runningModelId = null;
    for (let i = 0; i < 30; i += 1) {
      if (!(await isServerReady(DEFAULT_PORT))) return;
      await sleep(200);
    }
  }
}

async function callModel(messages, abortSignal) {
  const reasoning = getReasoningProfile();
  const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: getModelConfig().serverModel,
      messages,
      temperature: reasoning.temperature,
      max_tokens: reasoning.maxTokens,
      stream: true,
    }),
    signal: abortSignal,
  });
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

function textPreview(value, limit = 26000) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated]` : text;
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
  } else if (tool === "run_powershell") {
    result = await runPowerShell(String(args.command ?? ""), args.timeout);
  } else {
    throw new Error(`Nieznane narzedzie: ${tool}`);
  }

  emit("tool-result", { tool, ok: true, result });
  return result;
}

let messages = createInitialMessages();

function compactMessages() {
  if (messages.length > MAX_MESSAGES) {
    messages = [messages[0], ...messages.slice(-(MAX_MESSAGES - 1))];
  }
}

async function runAgent(userText) {
  if (runInProgress) throw new Error("Agent juz pracuje.");
  runInProgress = true;
  runAbortController = new AbortController();
  const signal = runAbortController.signal;
  try {
    await ensureServer(DEFAULT_PORT);
    messages.push({ role: "user", content: userText });
    emit("run-start", { text: userText });

    const reasoning = getReasoningProfile();
    for (let step = 1; step <= reasoning.maxSteps; step += 1) {
      if (signal.aborted) throw new Error("Przerwano przez uzytkownika.");
      compactMessages();
      emit("status", { status: "model-thinking", detail: `${getModelConfig().displayName} przygotowuje krok ${step}/${reasoning.maxSteps}.` });
      const raw = await callModel(messages, signal);
      emit("model-raw", { raw });
      const action = parseJsonAction(raw);
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
        toolPayload = { ok: false, error: error.message };
        emit("tool-result", { tool: action.tool, ok: false, error: error.message });
      }

      messages.push({
        role: "user",
        content: `Wynik narzedzia. Kontynuuj albo zakoncz finalem:\n${JSON.stringify(toolPayload, null, 2)}`,
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
    throw error;
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
  await fsp.mkdir(workspaceRoot, { recursive: true });
  loadChatHistory();
  const settings = loadAppSettings();
  if (settings.accessLevel) accessLevel = settings.accessLevel;
  createWindow();
});

app.on("window-all-closed", async () => {
  await stopOwnedServer();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await stopOwnedServer();
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
ipcMain.handle("agent:send", (_event, text) => runAgent(String(text ?? "")));
ipcMain.handle("agent:abort", () => {
  if (runAbortController) {
    runAbortController.abort();
    return { aborted: true };
  }
  return { aborted: false };
});
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
