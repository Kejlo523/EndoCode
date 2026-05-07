/* ── EndoCode Renderer ── */

// ── DOM Refs ──
const conversation = document.getElementById("conversation");
const welcomeScreen = document.getElementById("welcomeScreen");
const chatTitle = document.getElementById("chatTitle");
const contextText = document.getElementById("contextText");
const contextIndicator = document.getElementById("contextIndicator");
const composer = document.getElementById("composer");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const sendLabel = document.getElementById("sendLabel");
const sendIcon = document.getElementById("sendIcon");
const promptQueueBox = document.getElementById("promptQueue");
const promptQueueList = document.getElementById("promptQueueList");
const promptQueueCount = document.getElementById("promptQueueCount");
const modelSelect = document.getElementById("modelSelect");
const reasoningSelect = document.getElementById("reasoningSelect");
const accessToggle = document.getElementById("accessToggle");
const accessLabel = document.getElementById("accessLabel");
const workspaceLabel = document.getElementById("workspaceLabel");
const chooseWorkspaceBtn = document.getElementById("chooseWorkspace");
const newChatBtn = document.getElementById("newChatBtn");
const chatHistoryList = document.getElementById("chatHistoryList");
const composerWsName = document.getElementById("composerWsName");
const composerAccess = document.getElementById("composerAccess");
const miniStatus = document.getElementById("miniStatus");
const miniStatusText = document.getElementById("miniStatusText");
const liveDetailsPanel = document.getElementById("liveDetailsPanel");
const liveDetailsBody = document.getElementById("liveDetailsBody");
const liveDetailsClose = document.getElementById("liveDetailsClose");
const liveDetailsBackdrop = document.getElementById("liveDetailsBackdrop");
const liveRailToggle = document.getElementById("liveRailToggle");
const quickChoicesDock = document.getElementById("quickChoicesDock");

const attachBtn = document.getElementById("attachBtn");
const fileInput = document.getElementById("fileInput");
const attachmentPreview = document.getElementById("attachmentPreview");
const attachmentImage = document.getElementById("attachmentImage");
const attachmentFileMeta = document.getElementById("attachmentFileMeta");
const attachmentRemove = document.getElementById("attachmentRemove");
let currentAttachmentFile = null;
const approvalModal = document.getElementById("approvalModal");
const approvalCwd = document.getElementById("approvalCwd");
const approvalCommand = document.getElementById("approvalCommand");
const approveCommand = document.getElementById("approveCommand");
const rejectCommand = document.getElementById("rejectCommand");
const killServerBtn = document.getElementById("killServerBtn");
const modelsBtn = document.getElementById("modelsBtn");
const modelsModal = document.getElementById("modelsModal");
const closeModels = document.getElementById("closeModels");
const modelsList = document.getElementById("modelsList");
const modelsInstalledList = document.getElementById("modelsInstalledList");
const modelsStatus = document.getElementById("modelsStatus");
const modelsLocalSearch = document.getElementById("modelsLocalSearch");
const hfModelUrl = document.getElementById("hfModelUrl");
const addHfModel = document.getElementById("addHfModel");
const modelsLibraryStats = document.getElementById("modelsLibraryStats");
const modelsApiList = document.getElementById("modelsApiList");
const downloadCenter = document.getElementById("downloadCenter");
const downloadCenterList = document.getElementById("downloadCenterList");
const downloadCenterCount = document.getElementById("downloadCenterCount");
const downloadCenterToggle = document.getElementById("downloadCenterToggle");
const downloadCenterSummary = document.getElementById("downloadCenterSummary");
const modelsDownloadInline = document.getElementById("modelsDownloadInline");
const runtimeWarning = document.getElementById("runtimeWarning");
const installRuntimeBtn = document.getElementById("installRuntimeBtn");
const runtimeInstallProgress = document.getElementById("runtimeInstallProgress");
const runtimeInstallProgressFill = document.getElementById("runtimeInstallProgressFill");
const runtimeInstallProgressText = document.getElementById("runtimeInstallProgressText");




// System monitor refs
const cpuBar = document.getElementById("cpuBar");
const cpuValue = document.getElementById("cpuValue");
const gpuBar = document.getElementById("gpuBar");
const gpuValue = document.getElementById("gpuValue");
const ramBar = document.getElementById("ramBar");
const ramValue = document.getElementById("ramValue");
const vramBar = document.getElementById("vramBar");
const vramValue = document.getElementById("vramValue");

// Settings modal refs
const settingsBtn = document.getElementById("settingsBtn");
const settingsModal = document.getElementById("settingsModal");
const closeSettings = document.getElementById("closeSettings");
const applySettings = document.getElementById("applySettings");
const resetSettings = document.getElementById("resetSettings");
const settingsModelName = document.getElementById("settingsModelName");
const rawModelJson = document.getElementById("rawModelJson");

// ── State ──
let pendingApprovalId = null;
let appBusy = false;
let currentThinkingBubble = null;
let currentAccessLevel = "sandbox";
let currentWorkspaceRoot = "";
let chatSessions = [];
let activeChatId = null;
let runtimeInstallInProgress = false;
let currentSettingsModelId = null;
let refreshStateInFlight = false;
let updateSystemInFlight = false;
let streamingAssistantMessage = null;
const modelRenderCacheLibrary = new Map();
const modelRenderCacheInstalled = new Map();
const STREAM_RENDER_THROTTLE_MS = 50;
const SHOW_MODEL_THINKING_TRACE = true;
const liveDurationTrackers = new Map();
let liveDurationTicker = null;
let activeRunStartedAtMs = null;
let currentThinkingSegment = null;
const activeToolSegments = [];
let autoScrollPinned = true;
let lastConversationScrollTop = 0;
let currentFileChangeEvent = null;
let currentFileChanges = [];
let currentWebLookupEvent = null;
let promptQueueItems = [];
let promptQueueSeq = 0;
let promptQueueProcessing = false;
let finalReceivedInRun = false;
let apiProvidersState = [];
const modelDownloadState = new Map();
let downloadCenterCollapsed = true;
const modelsModule = window.EndoModules?.createModelsModule?.({
  modelsList,
  modelsInstalledList,
  modelsModal,
  modelsStatus,
  modelsLocalSearch,
  modelRenderCacheLibrary,
  modelRenderCacheInstalled,
  escapeHtml,
  escapeAttr,
  api: {
    listModels: () => window.endocode.listModels(),
  },
});

const API_PROVIDER_LABELS = {
  openai: "OpenAI",
  claude: "Claude",
  openrouter: "OpenRouter",
};

// ── Helpers ──
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ── Markdown & LaTeX Config ──
marked.setOptions({
  highlight: function (code, lang) {
    const language = hljs.getLanguage(lang) ? lang : "plaintext";
    return hljs.highlight(code, { language }).value;
  },
  langPrefix: "hljs language-",
  breaks: true,
  gfm: true,
});

function formatMessage(text) {
  if (!text) return "";
  // Render Markdown
  let html = marked.parse(text);
  
  // Create a temporary div to use KaTeX auto-render
  const temp = document.createElement("div");
  temp.innerHTML = html;
  
  renderMathInElement(temp, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\(", right: "\\)", display: false },
      { left: "\\[", right: "\\]", display: true },
      { left: "{\\displaystyle", right: "}", display: true }, // User's specific case
    ],
    throwOnError: false,
  });
  
  return temp.innerHTML;
}


function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "teraz";
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} godz.`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} d.`;
  return `${Math.floor(days / 7)} tyg.`;
}

function shortPath(fullPath) {
  if (!fullPath) return "workspace";
  const parts = fullPath.replace(/\\/g, "/").split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : fullPath;
}

function compactPath(fullPath, maxParts = 2) {
  const normalized = String(fullPath || "").replace(/\\/g, "/").trim();
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= maxParts) return normalized;
  return `.../${parts.slice(-maxParts).join("/")}`;
}

function fileNameFromPath(fullPath) {
  const normalized = String(fullPath || "").replace(/\\/g, "/").trim();
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) || normalized || "plik";
}

function shortenMiddle(value, max = 96) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const left = Math.max(12, Math.floor((max - 3) * 0.58));
  const right = Math.max(8, max - 3 - left);
  return `${text.slice(0, left)}...${text.slice(-right)}`;
}

function textStats(value) {
  const text = String(value ?? "");
  const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
  let bytes = text.length;
  try {
    bytes = new TextEncoder().encode(text).length;
  } catch { /* keep char-length fallback */ }
  return { lines, bytes };
}

function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function pickVariant(list, seed = 0) {
  if (!Array.isArray(list) || list.length === 0) return "";
  const n = Number(seed);
  const idx = Number.isFinite(n) ? Math.abs(Math.floor(n)) % list.length : 0;
  return list[idx];
}

function parseEventTimeMs(event) {
  const parsed = Date.parse(event?.at || "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function formatClockFromIso(isoAt) {
  const parsed = Date.parse(isoAt || "");
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return date.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
}

function formatDurationMmSs(durationMs) {
  const clamped = Math.max(0, Number(durationMs) || 0);
  const totalSec = Math.floor(clamped / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function renderDurationValue(labelEl, startedAtMs, endedAtMs = null) {
  if (!labelEl || !Number.isFinite(startedAtMs)) return;
  const endMs = Number.isFinite(endedAtMs) ? endedAtMs : Date.now();
  labelEl.textContent = formatDurationMmSs(endMs - startedAtMs);
}

function ensureDurationTicker() {
  if (liveDurationTicker) return;
  liveDurationTicker = setInterval(() => {
    for (const tracker of liveDurationTrackers.values()) {
      if (!tracker?.labelEl) continue;
      if (Number.isFinite(tracker.endedAtMs)) continue;
      renderDurationValue(tracker.labelEl, tracker.startedAtMs, null);
    }
  }, 1000);
}

function startLiveDuration(key, startedAtMs, labelEl) {
  if (!key || !labelEl) return;
  liveDurationTrackers.set(key, { startedAtMs, endedAtMs: null, labelEl });
  renderDurationValue(labelEl, startedAtMs, null);
  ensureDurationTicker();
}

function stopLiveDuration(key, endedAtMs) {
  const tracker = liveDurationTrackers.get(key);
  if (!tracker) return;
  tracker.endedAtMs = Number.isFinite(endedAtMs) ? endedAtMs : Date.now();
  renderDurationValue(tracker.labelEl, tracker.startedAtMs, tracker.endedAtMs);
  liveDurationTrackers.delete(key);
}

function stopAllLiveDurations() {
  for (const key of Array.from(liveDurationTrackers.keys())) {
    stopLiveDuration(key, Date.now());
  }
}

// ── Busy State ──
function setBusy(nextBusy) {
  appBusy = nextBusy;
  sendBtn.disabled = false;
  modelSelect.disabled = nextBusy;
  reasoningSelect.disabled = nextBusy;
  if (sendBtn) {
    sendBtn.classList.toggle("run-stop", nextBusy);
    sendBtn.title = nextBusy ? "Zatrzymaj (Enter)" : "Wyślij (Enter)";
  }
  if (sendLabel) sendLabel.textContent = nextBusy ? "Stop" : "Start";
  if (sendIcon) {
    sendIcon.innerHTML = nextBusy
      ? `<rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"></rect>`
      : `<path d="M3 13V3l11 5-11 5z" fill="currentColor"></path>`;
  }
  if (!nextBusy && promptQueueItems.some((item) => item.status === "queued")) {
    void processPromptQueue();
  }
}

function promptQueuePreview(item) {
  if (item.text) return item.text;
  if (item.attachment?.name) return `[Załącznik: ${item.attachment.name}]`;
  return "Obraz";
}

function addPromptToQueue(item) {
  promptQueueItems.push({
    id: `queued-${Date.now()}-${promptQueueSeq++}`,
    status: "queued",
    ...item,
  });
  renderPromptQueue();
  void processPromptQueue();
}

async function sendPromptPayload(item) {
  const payload = item.attachment
    ? { text: item.text || "", attachment: item.attachment }
    : item.text || "";
  await window.endocode.send(payload);
}

function movePromptInQueue(id, direction) {
  const currentIdx = promptQueueItems.findIndex((item) => item.id === id && item.status !== "running" && item.status !== "done");
  if (currentIdx < 0) return;
  const targetIdx = direction === "up" ? currentIdx - 1 : currentIdx + 1;
  if (targetIdx < 0 || targetIdx >= promptQueueItems.length) return;
  const target = promptQueueItems[targetIdx];
  if (!target || target.status === "running" || target.status === "done") return;
  const [item] = promptQueueItems.splice(currentIdx, 1);
  promptQueueItems.splice(targetIdx, 0, item);
  renderPromptQueue();
}

async function setPromptPriorityNow(id) {
  const idx = promptQueueItems.findIndex((item) => item.id === id && item.status !== "running" && item.status !== "done");
  if (idx < 0) return;
  const firstQueuedIdx = promptQueueItems.findIndex((item) => item.status === "queued" || item.status === "error");
  if (firstQueuedIdx < 0 || idx === firstQueuedIdx) return;
  const [item] = promptQueueItems.splice(idx, 1);
  item.status = "queued";
  promptQueueItems.splice(firstQueuedIdx, 0, item);
  renderPromptQueue();
  if (appBusy) {
    try {
      await window.endocode.abort();
    } catch (e) {
      addInlineEvent("error", "Kolejka", e.message || String(e));
    }
  } else {
    void processPromptQueue();
  }
}

function deletePromptFromQueue(id) {
  const idx = promptQueueItems.findIndex((item) => item.id === id && item.status !== "running");
  if (idx < 0) return;
  promptQueueItems.splice(idx, 1);
  renderPromptQueue();
}

function editPromptInQueue(id) {
  const item = promptQueueItems.find((entry) => entry.id === id && entry.status !== "running" && entry.status !== "done");
  if (!item) return;
  const updated = window.prompt("Edytuj prompt:", item.text || "");
  if (updated === null) return;
  const trimmed = String(updated).trim();
  if (!trimmed && !item.attachment) {
    deletePromptFromQueue(id);
    return;
  }
  item.text = trimmed;
  item.status = "queued";
  renderPromptQueue();
}

function renderPromptQueue() {
  if (!promptQueueBox || !promptQueueList || !promptQueueCount) return;
  const pendingCount = promptQueueItems.filter((item) => item.status !== "done").length;
  promptQueueCount.textContent = `${pendingCount}`;
  if (pendingCount === 0) {
    promptQueueBox.classList.add("hidden");
    promptQueueList.innerHTML = "";
    return;
  }
  promptQueueBox.classList.remove("hidden");
  promptQueueList.innerHTML = promptQueueItems
    .filter((item) => item.status !== "done")
    .map((item) => {
      const statusLabel = item.status === "running" ? "Wysyłanie" : item.status === "error" ? "Błąd" : "Oczekuje";
      return `
        <div class="prompt-queue-item ${item.status}">
          <div>
            <div class="prompt-queue-text">${escapeHtml(promptQueuePreview(item))}</div>
            <div class="prompt-queue-meta">${statusLabel}</div>
          </div>
          <div class="prompt-queue-actions">
            ${item.status !== "running" ? `<button data-queue-action="now" data-queue-id="${item.id}" title="Uruchom jako następny">Teraz</button>` : ""}
            ${item.status !== "running" ? `<button data-queue-action="up" data-queue-id="${item.id}" title="Przesuń wyżej">↑</button>` : ""}
            ${item.status !== "running" ? `<button data-queue-action="down" data-queue-id="${item.id}" title="Przesuń niżej">↓</button>` : ""}
            ${item.status !== "running" ? `<button data-queue-action="edit" data-queue-id="${item.id}" title="Edytuj">Edytuj</button>` : ""}
            ${item.status !== "running" ? `<button data-queue-action="delete" data-queue-id="${item.id}" title="Usuń">Usuń</button>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
}

async function processPromptQueue() {
  if (promptQueueProcessing || appBusy) return;
  const next = promptQueueItems.find((item) => item.status === "queued");
  if (!next) return;
  promptQueueProcessing = true;
  next.status = "running";
  renderPromptQueue();
  setBusy(true);
  try {
    await sendPromptPayload(next);
    next.status = "done";
  } catch (e) {
    next.status = "error";
    addInlineEvent("error", "Błąd", e.message || String(e));
  } finally {
    setBusy(false);
    hideLive();
    promptEl.focus();
    promptQueueProcessing = false;
    promptQueueItems = promptQueueItems.filter((item) => item.status !== "done");
    renderPromptQueue();
    await saveChatSession(firstUserMessage);
    await updateContextInfo();
    if (promptQueueItems.some((item) => item.status === "queued")) {
      void processPromptQueue();
    }
  }
}

// ── Mini Status (above composer) ──
function showMiniStatus(label) {
  const text = String(label || "").trim();
  if (!text) { hideMiniStatus(); return; }
  if (miniStatusText) miniStatusText.textContent = text;
  if (miniStatus) miniStatus.classList.remove("hidden");
}

function hideMiniStatus() {
  if (miniStatus) miniStatus.classList.add("hidden");
  if (miniStatusText) miniStatusText.textContent = "";
}

// ── Live Details Panel ──
let liveDetailsPanelOpen = false;
const LIVE_DETAILS_MAX_ENTRIES = 80;
const LIVE_DRAFT_RENDER_INTERVAL_MS = 160;
const liveEntryByKey = new Map();
let pendingLiveDraft = null;
let liveDraftTimer = null;

function syncLivePanelButtons() {
  const controls = [liveRailToggle].filter(Boolean);
  for (const control of controls) {
    control.classList.toggle("active", liveDetailsPanelOpen);
    control.setAttribute("aria-expanded", liveDetailsPanelOpen ? "true" : "false");
    control.title = liveDetailsPanelOpen ? "Ukryj akcje modelu" : "Pokaż akcje modelu";
  }
}

function openLiveDetails() {
  if (liveDetailsPanelOpen) return;
  liveDetailsPanelOpen = true;
  if (liveDetailsPanel) liveDetailsPanel.classList.add("open");
  if (liveDetailsBackdrop) liveDetailsBackdrop.classList.add("visible");
  syncLivePanelButtons();
}

function closeLiveDetails() {
  if (!liveDetailsPanelOpen) return;
  liveDetailsPanelOpen = false;
  if (liveDetailsPanel) liveDetailsPanel.classList.remove("open");
  if (liveDetailsBackdrop) liveDetailsBackdrop.classList.remove("visible");
  syncLivePanelButtons();
}

function clearLiveDetails() {
  liveEntryByKey.clear();
  if (liveDetailsBody) liveDetailsBody.innerHTML = '<div class="live-details-empty">Brak aktywnych akcji.</div>';
}

function renderLiveEntry(entry, kind, label, detail = "", options = {}) {
  const className = `live-entry ${kind ? `live-entry--${kind}` : ""}${options.active ? " live-entry--active" : ""}`;
  if (entry.className !== className) entry.className = className;
  if (!entry.dataset.eventAt) entry.dataset.eventAt = options.eventAt || new Date().toISOString();

  let head = entry.querySelector(".live-entry-head");
  if (!head) {
    head = document.createElement("div");
    head.className = "live-entry-head";
    const labelEl = document.createElement("div");
    labelEl.className = "live-entry-label";
    const timeEl = document.createElement("time");
    timeEl.className = "live-entry-time";
    head.append(labelEl, timeEl);
    entry.appendChild(head);
  }

  const labelEl = head.querySelector(".live-entry-label");
  const timeEl = head.querySelector(".live-entry-time");
  const nextLabel = String(label || "").trim() || "Akcja";
  const nextTime = formatClockFromIso(entry.dataset.eventAt);
  if (labelEl && labelEl.textContent !== nextLabel) labelEl.textContent = nextLabel;
  if (timeEl && timeEl.textContent !== nextTime) timeEl.textContent = nextTime;

  const nextDetail = String(detail || "").trim().slice(0, 5000);
  let detailEl = entry.querySelector(".live-entry-detail");
  if (nextDetail) {
    if (!detailEl) {
      detailEl = document.createElement("div");
      detailEl.className = "live-entry-detail";
      entry.appendChild(detailEl);
    }
    if (detailEl.textContent !== nextDetail) detailEl.textContent = nextDetail;
  } else if (detailEl) {
    detailEl.remove();
  }
}

function trimLiveEntries() {
  if (!liveDetailsBody) return;
  while (liveDetailsBody.children.length > LIVE_DETAILS_MAX_ENTRIES) {
    const first = liveDetailsBody.firstElementChild;
    if (first?.dataset?.liveKey) liveEntryByKey.delete(first.dataset.liveKey);
    liveDetailsBody.removeChild(first);
  }
}

function isLiveDetailsNearBottom(threshold = 80) {
  if (!liveDetailsBody) return true;
  const distanceToBottom = liveDetailsBody.scrollHeight - liveDetailsBody.scrollTop - liveDetailsBody.clientHeight;
  return distanceToBottom <= threshold;
}

function maybeScrollLiveDetails(force = false) {
  if (!liveDetailsBody) return;
  if (!force && !isLiveDetailsNearBottom()) return;
  requestAnimationFrame(() => {
    liveDetailsBody.scrollTop = liveDetailsBody.scrollHeight;
  });
}

function pushLiveEntry(kind, label, detail = "", options = {}) {
  if (!liveDetailsBody) return;
  const empty = liveDetailsBody.querySelector(".live-details-empty");
  if (empty) empty.remove();
  const key = String(options.key || "").trim();
  if (key) {
    let keyedEntry = liveEntryByKey.get(key);
    const wasNearBottom = isLiveDetailsNearBottom();
    let created = false;
    if (!keyedEntry || !keyedEntry.isConnected) {
      keyedEntry = document.createElement("div");
      keyedEntry.dataset.liveKey = key;
      liveEntryByKey.set(key, keyedEntry);
      liveDetailsBody.appendChild(keyedEntry);
      created = true;
    }
    renderLiveEntry(keyedEntry, kind, label, detail, options);
    if (options.moveToBottom === true && liveDetailsBody.lastElementChild !== keyedEntry) {
      liveDetailsBody.appendChild(keyedEntry);
    }
    trimLiveEntries();
    maybeScrollLiveDetails(created || wasNearBottom || options.forceScroll === true);
    return keyedEntry;
  }

  const signature = `${kind}|${String(label || "").trim()}|${String(detail || "").trim()}`;
  const last = liveDetailsBody.lastElementChild;
  if (last?.dataset?.signature === signature) return last;
  const entry = document.createElement("div");
  entry.dataset.signature = signature;
  renderLiveEntry(entry, kind, label, detail, options);
  liveDetailsBody.appendChild(entry);
  trimLiveEntries();
  maybeScrollLiveDetails(true);
  return entry;
}

function updateLiveDraft(label, detail = "") {
  pendingLiveDraft = { label, detail };
  if (liveDraftTimer) return;
  liveDraftTimer = setTimeout(() => {
    liveDraftTimer = null;
    if (!pendingLiveDraft) return;
    const next = pendingLiveDraft;
    pendingLiveDraft = null;
    pushLiveEntry("draft", next.label, next.detail, { key: "model-draft", active: true });
  }, LIVE_DRAFT_RENDER_INTERVAL_MS);
}

function clearLiveDraft() {
  pendingLiveDraft = null;
  if (liveDraftTimer) {
    clearTimeout(liveDraftTimer);
    liveDraftTimer = null;
  }
  const draft = liveEntryByKey.get("model-draft");
  if (draft?.isConnected) draft.remove();
  liveEntryByKey.delete("model-draft");
}

if (liveDetailsClose) liveDetailsClose.addEventListener("click", closeLiveDetails);
if (liveDetailsBackdrop) liveDetailsBackdrop.addEventListener("click", closeLiveDetails);
if (liveRailToggle) liveRailToggle.addEventListener("click", () => {
  if (liveDetailsPanelOpen) closeLiveDetails(); else openLiveDetails();
});
syncLivePanelButtons();

// Compat wrappers — showLive/hideLive now update mini-status + push to live panel
let _lastLiveLabel = "";
let _liveDebounce = null;
function showLive(label, detail = "") {
  showMiniStatus(label);
  const sig = `${label}|${detail}`;
  if (sig === _lastLiveLabel) return;
  _lastLiveLabel = sig;
  if (_liveDebounce) clearTimeout(_liveDebounce);
  _liveDebounce = setTimeout(() => {
    _liveDebounce = null;
    pushLiveEntry("phase", label, detail, { key: "status-current", active: true });
  }, 400);
}

function hideLive() {
  hideMiniStatus();
  _lastLiveLabel = "";
  if (_liveDebounce) { clearTimeout(_liveDebounce); _liveDebounce = null; }
}

// ── Animated Collapse Helper ──
function animateCollapse(el, expand) {
  if (!el) return;
  if (expand) {
    el.classList.add("expanded");
    el.style.maxHeight = el.scrollHeight + "px";
    const onEnd = () => {
      el.removeEventListener("transitionend", onEnd);
      if (el.classList.contains("expanded")) el.style.maxHeight = "none";
    };
    el.addEventListener("transitionend", onEnd);
  } else {
    el.style.maxHeight = el.scrollHeight + "px";
    requestAnimationFrame(() => {
      el.style.maxHeight = "0";
      el.classList.remove("expanded");
    });
  }
}

// ── Welcome Screen ──
function updateWelcome() {
  const welcome = document.getElementById("welcomeScreen");
  const hasMessages = conversation.querySelectorAll(".message, .inline-event, .thinking-bubble").length > 0;
  if (welcome) {
    welcome.style.display = hasMessages ? "none" : "";
  }
}

function isConversationNearBottom(threshold = 140) {
  const distanceToBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
  return distanceToBottom <= threshold;
}

conversation.addEventListener("scroll", () => {
  const currentTop = conversation.scrollTop;
  const scrollingUp = currentTop < lastConversationScrollTop - 2;
  const nearBottom = isConversationNearBottom(24);
  if (scrollingUp) {
    autoScrollPinned = false;
  } else if (nearBottom) {
    autoScrollPinned = true;
  }
  lastConversationScrollTop = currentTop;
}, { passive: true });

function smartScroll(options = {}) {
  const force = options.force === true;
  if (!force && !autoScrollPinned) return;
  requestAnimationFrame(() => {
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: options.smooth ? "smooth" : "auto" });
  });
}

function clearQuickChoicesDock() {
  if (!quickChoicesDock) return;
  quickChoicesDock.classList.add("hidden");
  quickChoicesDock.innerHTML = "";
}

function resetTurnActivity() {
  currentFileChangeEvent = null;
  currentFileChanges = [];
  currentWebLookupEvent = null;
  clearQuickChoicesDock();
}

function setLiveIdle() {
  hideMiniStatus();
}

function compactToolResultSummary(tool, result = {}) {
  if (tool === "read_file") return result?.path ? `Odczytano ${result.path}` : "Odczytano plik";
  if (tool === "ls") return result?.path ? `Lista ${result.path}` : "Lista katalogu";
  if (tool === "pwd") return "Sprawdzono ścieżkę";
  if (tool === "cd") return result?.cwd ? `Katalog: ${result.cwd}` : "Zmieniono katalog";
  if (tool === "run_powershell") {
    const code = Number(result?.exitCode);
    return Number.isFinite(code) ? `Kod wyjścia ${code}` : "Komenda zakończona";
  }
  if (result?.path) return String(result.path);
  return "Gotowe";
}

// ── Messages ──
function addMessage(role, text, imageBase64 = null) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.setAttribute("data-raw-text", String(text ?? ""));
  if (role === "assistant" && /^(Zadanie zatrzymane|Nie udalo sie wygenerowac odpowiedzi)/i.test(String(text || "").trim())) {
    div.classList.add("message-error");
  }
  
  if (imageBase64) {
    const img = document.createElement("img");
    img.src = imageBase64;
    img.style.maxWidth = "260px";
    img.style.maxHeight = "260px";
    img.style.borderRadius = "var(--radius-sm)";
    img.style.display = "block";
    if (text && text !== "[Wysłano obraz]") {
      img.style.marginBottom = "10px";
    }
    div.appendChild(img);
  }
  
  if (text && text !== "[Wysłano obraz]") {
    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content";
    contentDiv.innerHTML = formatMessage(text);
    div.appendChild(contentDiv);
  }

  
  conversation.appendChild(div);
  smartScroll();
  updateWelcome();
}

function startStreamingAssistantMessage() {
  if (streamingAssistantMessage?.root?.isConnected) return streamingAssistantMessage;
  const root = document.createElement("div");
  root.className = "message assistant";
  const content = document.createElement("div");
  content.className = "message-content";
  root.appendChild(content);
  conversation.appendChild(root);
  streamingAssistantMessage = {
    root,
    content,
    fullText: "",
    renderedText: "",
    renderTimer: null,
    lastRenderAt: 0,
  };
  root.setAttribute("data-raw-text", "");
  smartScroll();
  updateWelcome();
  return streamingAssistantMessage;
}

function renderStreamingAssistantMessage(force = false) {
  const state = streamingAssistantMessage;
  if (!state?.content) return;
  if (!force && state.renderedText === state.fullText) return;

  const now = Date.now();
  const elapsed = now - state.lastRenderAt;
  if (!force && elapsed < STREAM_RENDER_THROTTLE_MS) {
    if (state.renderTimer) return;
    state.renderTimer = setTimeout(() => {
      if (!streamingAssistantMessage) return;
      streamingAssistantMessage.renderTimer = null;
      renderStreamingAssistantMessage(true);
    }, STREAM_RENDER_THROTTLE_MS - elapsed);
    return;
  }

  if (state.renderTimer) {
    clearTimeout(state.renderTimer);
    state.renderTimer = null;
  }
  state.content.innerHTML = formatMessage(state.fullText);
  state.renderedText = state.fullText;
  state.lastRenderAt = Date.now();
  smartScroll();
}

function updateStreamingAssistantMessage(deltaText = "", fullText = null) {
  const state = startStreamingAssistantMessage();
  if (typeof fullText === "string") state.fullText = fullText;
  else state.fullText += String(deltaText ?? "");
  if (state.root) state.root.setAttribute("data-raw-text", state.fullText);
  renderStreamingAssistantMessage(false);
}

function hasStreamingAssistantContent() {
  const fullText = String(streamingAssistantMessage?.fullText || "").trim();
  return fullText.length > 0;
}

function extractLiveAnswerFromDelta(fullText = "") {
  const text = String(fullText || "");
  if (!text.trim()) return "";
  const finalMatch = text.match(/\bFINAL\s*:\s*([\s\S]*)$/i);
  if (finalMatch?.[1]) return finalMatch[1].trimStart();
  const jsonFinalStart = text.match(/"final"\s*:\s*"/i);
  if (jsonFinalStart) {
    const startIndex = (jsonFinalStart.index || 0) + jsonFinalStart[0].length;
    const raw = text.slice(startIndex);
    let out = "";
    let escaping = false;
    for (const ch of raw) {
      if (escaping) {
        if (ch === "n") out += "\n";
        else if (ch === "t") out += "\t";
        else if (ch === "r") out += "\r";
        else out += ch;
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (ch === "\"") break;
      out += ch;
    }
    return out.trimStart();
  }
  return "";
}

function decodeJsonishString(value = "") {
  const raw = String(value || "");
  try {
    return JSON.parse(`"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  } catch {
    return raw
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function extractQuotedJsonField(text = "", field = "") {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, "i");
  const match = String(text || "").match(re);
  return match?.[1] ? decodeJsonishString(match[1]) : "";
}

function compactModelDraftPreview(fullText = "", fallback = "") {
  const text = String(fullText || "").trim();
  if (!text) return String(fallback || "").trim();
  const tool = extractQuotedJsonField(text, "tool");
  const note = extractQuotedJsonField(text, "note");
  const path = extractQuotedJsonField(text, "path") || extractQuotedJsonField(text, "url");
  const mode = extractQuotedJsonField(text, "mode");
  if (tool) {
    return [
      `akcja: ${tool}`,
      path ? `cel: ${compactPath(path, 3) || shortenMiddle(path, 90)}` : "",
      mode ? `tryb: ${mode}` : "",
      note ? `notatka: ${shortenMiddle(note, 140)}` : "",
    ].filter(Boolean).join("\n");
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastReadable = [...lines].reverse().find((line) => {
    if (/^[{}\][,:"]+$/.test(line)) return false;
    if (/^"(tool|args|content|replace|search|path|note)"\s*:/i.test(line)) return false;
    return /[a-ząćęłńóśźż0-9]/i.test(line);
  });
  if (lastReadable && !/^\{/.test(lastReadable)) return shortenMiddle(lastReadable, 220);
  return String(fallback || "Odbieram strukturę akcji...").trim();
}

function finalizeStreamingAssistantMessage(finalText = "", options = {}) {
  const overwriteText = options?.overwriteText !== false;
  const state = streamingAssistantMessage;
  if (!state?.content) {
    if (overwriteText) addMessage("assistant", finalText || "");
    return;
  }
  if (overwriteText && typeof finalText === "string" && finalText.length > 0) {
    state.fullText = finalText;
  }
  if (state.root) state.root.setAttribute("data-raw-text", state.fullText);
  renderStreamingAssistantMessage(true);
  streamingAssistantMessage = null;
}

// ── Inline Events (replaces separate activity panel) ──
const INLINE_EVENT_ICONS = {
  tool: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 2l8 6-8 6V2z" fill="currentColor"/></svg>`,
  note: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v4M8 11v.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  error: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1l7 13H1L8 1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/></svg>`,
  change: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  activity: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M2 8h2M12 8h2M8 2v2M8 12v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
};

function setInlineEventIconKind(el, nextKind) {
  const slot = el?.querySelector(".inline-event-icon");
  if (!slot) return;
  slot.innerHTML = INLINE_EVENT_ICONS[nextKind] || INLINE_EVENT_ICONS.note;
}

function syncInlineEventPersistAttrs(el) {
  if (!el?.classList.contains("inline-event")) return;
  const titleEl = el.querySelector(".inline-event-title");
  const detailEl = el.querySelector(".inline-event-detail");
  const expandEl = el.querySelector(".inline-event-expand");
  if (titleEl) el.setAttribute("data-title", titleEl.textContent || "");
  if (detailEl) el.setAttribute("data-body", detailEl.textContent || "");
  el.setAttribute("data-extra-html", expandEl ? expandEl.innerHTML : "");
}

function addInlineEvent(kind, title, body = "", extraHtml = "", options = {}) {
  const iconMap = INLINE_EVENT_ICONS;
  let normalizedBody = String(body || "");
  let normalizedExtraHtml = String(extraHtml || "");
  if (kind === "error" && normalizedBody && !normalizedExtraHtml) {
    const firstLine = normalizedBody.split("\n").find((line) => String(line || "").trim()) || normalizedBody;
    normalizedBody = firstLine;
    normalizedExtraHtml = `<pre class="inline-error-full">${escapeHtml(body)}</pre>`;
  }

  const variant = options.variant || "";
  const isToolcard = variant === "toolcard";
  const primaryHtml = options.primaryHtml || "";
  const showPrimary = Boolean(primaryHtml) || isToolcard;

  const div = document.createElement("div");
  div.className = `inline-event ${kind}${isToolcard ? " inline-event--toolcard" : ""}`;
  div.setAttribute("data-kind", kind);
  div.setAttribute("data-title", title);
  div.setAttribute("data-body", normalizedBody);
  div.setAttribute("data-extra-html", normalizedExtraHtml || "");
  const techOpen = Boolean(options.defaultExpanded);
  div.setAttribute("data-expanded", techOpen ? "true" : "false");
  if (isToolcard) div.setAttribute("data-variant", "toolcard");
  const eventTime = formatClockFromIso(options.eventAt);
  const durationHtml = options.showDuration
    ? `<span class="inline-event-duration">${escapeHtml(options.duration || "00:00")}</span>`
    : "";
  const hasDetail = Boolean(normalizedBody || normalizedExtraHtml);
  if (hasDetail) div.classList.add("inline-event--has-detail");
  const detailId = `inline-event-detail-${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)}`;
  const expandLabel = isToolcard && hasDetail ? "Szczegóły techniczne" : "szczegóły";
  const expandToggle = hasDetail ? `<span class="inline-event-expand-toggle">${expandLabel}</span>` : "";
  const primaryBlock = showPrimary
    ? `<div class="inline-event-primary">${primaryHtml || (isToolcard ? "" : "")}</div>`
    : "";
  const detailExpandedClass = techOpen ? " expanded" : "";

  div.innerHTML = `
    <span class="inline-event-icon" aria-hidden="true">${iconMap[kind] || iconMap.note}</span>
    <div class="inline-event-body">
      <button class="inline-event-summary ${hasDetail ? "" : "no-detail"}" type="button" ${hasDetail ? `aria-controls="${detailId}" aria-expanded="${techOpen ? "true" : "false"}"` : "disabled"}>
        <span class="inline-event-title">${escapeHtml(title)}</span>
        ${expandToggle}
      </button>
      ${primaryBlock}
      <div class="inline-event-detail-wrap${detailExpandedClass}" id="${detailId}">
        ${normalizedBody ? `<div class="inline-event-detail">${escapeHtml(normalizedBody)}</div>` : ""}
        ${normalizedExtraHtml ? `<div class="inline-event-expand">${normalizedExtraHtml}</div>` : ""}
      </div>
    </div>
    <div class="inline-event-meta">
      <span class="inline-event-time">${eventTime}</span>
      ${durationHtml}
    </div>
  `;
  const summaryBtn = div.querySelector(".inline-event-summary");
  if (hasDetail && summaryBtn) {
    summaryBtn.addEventListener("click", () => {
      const detailWrap = div.querySelector(".inline-event-detail-wrap");
      if (!detailWrap) return;
      const isExpanded = detailWrap.classList.contains("expanded");
      animateCollapse(detailWrap, !isExpanded);
      div.setAttribute("data-expanded", isExpanded ? "false" : "true");
      summaryBtn.setAttribute("aria-expanded", isExpanded ? "false" : "true");
      if (!isExpanded) {
        requestAnimationFrame(() => {
          detailWrap.scrollTop = 0;
          smartScroll({ smooth: true });
        });
      } else {
        smartScroll();
      }
    });
  }
  conversation.appendChild(div);
  // If starting expanded, ensure the detail wrap is visible immediately
  if (techOpen) {
    const dw = div.querySelector(".inline-event-detail-wrap");
    if (dw) {
      dw.style.maxHeight = "none";
      dw.style.opacity = "1";
    }
  }
  syncInlineEventPersistAttrs(div);
  smartScroll();
  updateWelcome();
  return div;
}

function buildQuickChoicesHtml(payload = {}) {
  const title = String(payload?.title || "Wybierz opcję");
  const options = Array.isArray(payload?.options) ? payload.options : [];
  const buttons = options
    .slice(0, 6)
    .map((opt) => {
      const key = escapeAttr(opt?.key || "");
      const label = escapeHtml(opt?.label || key || "Opcja");
      const prompt = escapeAttr(opt?.prompt || "");
      return `<button class="quick-choice-btn" data-quick-choice="preset" data-choice-key="${key}" data-choice-prompt="${prompt}">${label}</button>`;
    })
    .join("");
  const otherLabel = escapeHtml(payload?.otherLabel || "Other");
  return `
    <div class="quick-choices-wrap">
      <div class="quick-choices-title">${escapeHtml(title)}</div>
      <div class="quick-choices-grid">${buttons}</div>
      <button class="quick-choice-btn other" data-quick-choice="other">${otherLabel}</button>
    </div>
  `;
}

function renderQuickChoicesDock(payload = {}) {
  if (!quickChoicesDock) return;
  quickChoicesDock.innerHTML = buildQuickChoicesHtml(payload);
  quickChoicesDock.classList.remove("hidden");
}

async function submitQuickChoicePrompt(text) {
  const prompt = String(text || "").trim();
  if (!prompt) return;
  clearQuickChoicesDock();
  if (!firstUserMessage) firstUserMessage = prompt;
  addMessage("user", prompt);
  chatTitle.textContent = prompt.length > 40 ? `${prompt.slice(0, 40)}...` : prompt;
  await saveChatSession(firstUserMessage);
  const submission = { text: prompt, attachment: null };
  const hasQueuedWork = promptQueueItems.some((item) => item.status === "queued" || item.status === "running");
  if (!appBusy && !hasQueuedWork) {
    setBusy(true);
    try {
      await sendPromptPayload(submission);
    } catch (e) {
      addInlineEvent("error", "Błąd", e.message || String(e));
      setBusy(false);
      hideLive();
      promptEl.focus();
      await saveChatSession(firstUserMessage);
      await updateContextInfo();
    }
    return;
  }
  addPromptToQueue(submission);
  promptEl.focus();
}

function removeInlineEventByActivityId(activityId) {
  const el = conversation.querySelector(`.inline-event[data-activity-id="${activityId}"]`);
  if (el) el.remove();
}

const MODEL_WRITING_ACTIVITY_ID = "model-writing";
let lastAgentPhaseSignature = "";
let agentPhaseHistoryLines = [];

const AGENT_PHASE_MESSAGES = {
  understand: ["Łapię sens zadania", "Czytam intencję", "Porządkuję kontekst"],
  plan: ["Układam następny krok", "Szkicuję mały plan", "Dobieram ruch"],
  validate: ["Sprawdzam kontrakt akcji", "Prześwietlam następny ruch", "Pilnuję formatu"],
  execute: ["Wykonuję krok", "Pracuję na plikach", "Odpalam działanie"],
  observe: ["Czytam wynik", "Patrzę, co wróciło", "Zbieram efekt"],
  recover: ["Naprawiam tor jazdy", "Koryguję odpowiedź modelu", "Szukam obejścia"],
  finalize: ["Składam odpowiedź", "Domykam zadanie", "Porządkuję wynik"],
};

function friendlyAgentPhaseLabel(phase, event = {}) {
  const list = AGENT_PHASE_MESSAGES[phase] || ["Pracuję nad zadaniem"];
  return pickVariant(list, Number(event.step || agentPhaseHistoryLines.length || 0));
}

function friendlyAgentPhaseDetail(event = {}) {
  const parts = [];
  if (event.tool) parts.push(`narzędzie: ${event.tool}`);
  if (event.reason) parts.push(shortenMiddle(event.reason, 90));
  return parts.join(" · ");
}

function upsertInlineEvent(activityId, kind, title, body = "", options = {}) {
  const safeBody = String(body ?? "").slice(0, 50000);
  const keepExpanded = options.keepExpanded === true;
  const defaultExpanded = options.defaultExpanded === true;
  const moveToBottom = options.moveToBottom === true;
  const className = String(options.className || "").trim();
  let el = conversation.querySelector(`.inline-event[data-activity-id="${activityId}"]`);
  if (!el) {
    el = addInlineEvent(kind, title, safeBody, "", { defaultExpanded });
    el.setAttribute("data-activity-id", activityId);
    if (className) el.classList.add(...className.split(/\s+/).filter(Boolean));
  } else {
    el.setAttribute("data-title", title);
    el.setAttribute("data-body", safeBody);
    const hadDetailsBefore = Boolean(el.querySelector(".inline-event-detail")?.textContent || el.querySelector(".inline-event-expand"));
    const hasDetailsNow = Boolean(safeBody);
    const summaryBtn = el.querySelector(".inline-event-summary");
    const titleEl = el.querySelector(".inline-event-title");
    const detailEl = el.querySelector(".inline-event-detail");
    if (titleEl) titleEl.textContent = title;
    if (detailEl) detailEl.textContent = safeBody;
    else if (safeBody) {
      const detailWrap = el.querySelector(".inline-event-detail-wrap");
      if (detailWrap) {
        const div = document.createElement("div");
        div.className = "inline-event-detail";
        div.textContent = safeBody;
        detailWrap.prepend(div);
      }
    }
    if (summaryBtn) {
      summaryBtn.disabled = !hasDetailsNow && !hadDetailsBefore;
      summaryBtn.classList.toggle("no-detail", summaryBtn.disabled);
    }
    el.classList.toggle("inline-event--has-detail", hasDetailsNow || hadDetailsBefore);
    if (keepExpanded) {
      const detailWrap = el.querySelector(".inline-event-detail-wrap");
      if (detailWrap) animateCollapse(detailWrap, true);
      if (summaryBtn) summaryBtn.setAttribute("aria-expanded", "true");
      el.setAttribute("data-expanded", "true");
    }
    if (className) el.classList.add(...className.split(/\s+/).filter(Boolean));
    syncInlineEventPersistAttrs(el);
    smartScroll();
  }
  if (moveToBottom && el?.isConnected && conversation.lastElementChild !== el) {
    conversation.appendChild(el);
    smartScroll();
  }
}

function setInlineEventDuration(el, durationText) {
  if (!el) return;
  const meta = el.querySelector(".inline-event-meta");
  if (!meta) return;
  let durationEl = el.querySelector(".inline-event-duration");
  if (!durationEl) {
    durationEl = document.createElement("span");
    durationEl.className = "inline-event-duration";
    meta.appendChild(durationEl);
  }
  durationEl.textContent = durationText;
}

function compactJsonPreview(value) {
  try {
    return JSON.stringify(value, null, 2).slice(0, 50000);
  } catch {
    return String(value ?? "").slice(0, 50000);
  }
}

function toolTargetText(tool, args = {}) {
  if (tool === "run_powershell") return shortenMiddle(args?.command || "", 120);
  if (tool === "fetch_url" || tool === "download_file") return shortenMiddle(args?.url || args?.downloadUrl || args?.path || "", 120);
  return compactPath(toolSegmentPath(tool, args) || args?.path || args?.url || "", 2);
}

function toolActionDetail(tool, args, note = "") {
  const parts = [];
  if (note) parts.push(note);
  if (tool === "run_powershell" && args?.command) parts.push(args.command);
  else if (tool === "write_file" && args?.path) {
    const stats = textStats(args.content || "");
    parts.push(`plik: ${args.path}`);
    if (stats.lines || stats.bytes) parts.push(`${stats.lines} linii · ${formatBytes(stats.bytes)}`);
  }
  else if (tool === "patch_edit" && args?.path) parts.push(`plik: ${args.path}`);
  else if (tool === "patch_batch") parts.push("pakiet bloków SEARCH/REPLACE");
  else if (args && Object.keys(args).length) parts.push(compactJsonPreview(args));
  return parts.join("\n");
}

function toolResultDetailForLive(tool, result = {}, event = {}) {
  if (!event?.ok) {
    return `${event?.error || ""}${event?.recoveryHint ? `\nObejście: ${event.recoveryHint}` : ""}`.trim();
  }
  if (tool === "run_powershell") {
    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();
    return [
      result.cwd ? `[cwd] ${result.cwd}` : "",
      Number.isFinite(Number(result.exitCode)) ? `[exit] ${result.exitCode}` : "",
      stdout ? `[stdout]\n${stdout}` : "",
      stderr ? `[stderr]\n${stderr}` : "",
    ].filter(Boolean).join("\n\n") || "Brak danych wyjściowych.";
  }
  if (tool === "read_file") {
    const content = String(result.content || "");
    const stats = textStats(content);
    return [
      result.path ? `plik: ${result.path}` : "",
      `${stats.lines} linii · ${formatBytes(stats.bytes)}`,
      result.truncated ? "wynik skrócony" : "",
      content ? `\n${content.slice(0, 5000)}` : "",
    ].filter(Boolean).join("\n");
  }
  try {
    return JSON.stringify(result || {}, null, 2).slice(0, 5000);
  } catch {
    return String(result || "").slice(0, 5000);
  }
}

function toolActionLabel(tool, args) {
  const target = toolTargetText(tool, args || {});
  if (tool == null) {
    return "Błąd: brak pola tool w odpowiedzi modelu";
  }
  switch (tool) {
    case "read_file": return `Czytam plik${target ? `: ${target}` : ""}`;
    case "write_file": return `Piszę plik${target ? `: ${target}` : ""}`;
    case "patch_edit": return `Kreślę zmiany${target ? `: ${target}` : ""}`;
    case "patch_batch": return "Nakładam pakiet zmian";
    case "ls": return `Przeglądam katalog${target ? `: ${target}` : ""}`;
    case "cd": return `Przechodzę do ${target || "katalogu"}`;
    case "pwd": return "Sprawdza ścieżkę";
    case "mkdir": return `Tworzę katalog${target ? `: ${target}` : ""}`;
    case "run_powershell": return "Uruchamiam komendę";
    case "fetch_url": return `Pobieram stronę${target ? `: ${target}` : ""}`;
    case "extract_media": return `Szukam mediów${target ? `: ${target}` : ""}`;
    case "download_file": return `Pobieram plik${target ? `: ${target}` : ""}`;
    default: return `Narzędzie: ${tool}`;
  }
}

function normalizePathForMatch(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase().trim();
}

function toolSegmentPath(tool, args) {
  if (!args) return "";
  if (tool === "patch_batch") {
    const blocks = Array.isArray(args.blocks) ? args.blocks : [];
    const first = blocks[0]?.path || args.defaultPath;
    return String(first || "").trim();
  }
  return String(args.path || "").trim();
}

function collectDiffHunks(diff) {
  if (!Array.isArray(diff) || diff.length === 0) return { hunks: [], added: 0, removed: 0 };
  const added = diff.filter((r) => r.type === "add").length;
  const removed = diff.filter((r) => r.type === "remove").length;
  const hunks = [];
  let currentHunk = null;
  for (let i = 0; i < diff.length; i++) {
    const row = diff[i];
    if (row.type === "add" || row.type === "remove") {
      if (!currentHunk) {
        currentHunk = { startLine: i + 1, lines: [] };
        for (let c = Math.max(0, i - 2); c < i; c++) {
          currentHunk.lines.push({ ...diff[c], lineNo: c + 1 });
          currentHunk.startLine = c + 1;
        }
      }
      currentHunk.lines.push({ ...row, lineNo: i + 1 });
    } else {
      if (currentHunk) {
        currentHunk.lines.push({ ...row, lineNo: i + 1 });
        if (i + 1 < diff.length && (diff[i + 1].type === "add" || diff[i + 1].type === "remove")) {
          continue;
        }
        if (i + 2 < diff.length && diff[i + 1]?.type === "same" && (diff[i + 2]?.type === "add" || diff[i + 2]?.type === "remove")) {
          continue;
        }
        hunks.push(currentHunk);
        currentHunk = null;
      }
    }
  }
  if (currentHunk) hunks.push(currentHunk);
  return { hunks, added, removed };
}

/** DOM diff block: stats in summary, hunks scrollable, collapsed by default. */
function buildDiffDetailsElement(diff, options = {}) {
  const details = document.createElement("details");
  details.className = "diff-details";
  details.open = options.open === true;
  const summary = document.createElement("summary");
  summary.className = String(options.summaryClass || "diff-summary");
  const { hunks, added, removed } = collectDiffHunks(diff);
  if (hunks.length === 0) {
    if (options.summaryHtml) summary.innerHTML = String(options.summaryHtml);
    else summary.textContent = "Brak zmian w diffie";
    details.appendChild(summary);
    return details;
  }
  if (options.summaryHtml) {
    summary.innerHTML = String(options.summaryHtml)
      .replaceAll("{{added}}", String(added))
      .replaceAll("{{removed}}", String(removed));
  } else {
    summary.innerHTML = `<span class="diff-stat-plus">+${added}</span> <span class="diff-stat-minus">−${removed}</span><span class="diff-toggle-hint">podgląd zmian</span>`;
  }
  const inner = document.createElement("div");
  inner.className = "diff diff--scroll";
  for (const hunk of hunks) {
    const hWrap = document.createElement("div");
    hWrap.className = "diff-hunk";
    const hh = document.createElement("div");
    hh.className = "diff-hunk-header";
    hh.textContent = `@@ linia ${hunk.startLine} @@`;
    hWrap.appendChild(hh);
    for (const r of hunk.lines) {
      const row = document.createElement("div");
      row.className = `diff-row ${r.type}`;
      const ln = document.createElement("span");
      ln.className = "diff-lineno";
      ln.textContent = String(r.lineNo);
      const prefix = r.type === "add" ? "+ " : r.type === "remove" ? "− " : "  ";
      row.appendChild(ln);
      row.appendChild(document.createTextNode(prefix + String(r.text ?? "")));
      hWrap.appendChild(row);
    }
    inner.appendChild(hWrap);
  }
  details.appendChild(summary);
  details.appendChild(inner);
  return details;
}

function renderDiff(diff) {
  const el = buildDiffDetailsElement(diff);
  return el.outerHTML;
}

function fileChangeActionLabel(action) {
  if (action === "write_file") return "Zapisano";
  if (action === "patch_edit") return "Edytowano";
  if (action === "download_file") return "Pobrano";
  if (action === "undo_file_change") return "Cofnięto";
  if (action === "redo_file_change") return "Przywrócono";
  return "Edycja";
}

function historyKeyFromPath(filePath = "") {
  return normalizePathForMatch(filePath);
}

function buildFileHistoryControlsHtml(history = {}, filePath = "") {
  if (!history || history.available !== true) return "";
  const safeKey = escapeAttr(historyKeyFromPath(filePath));
  const safePath = escapeAttr(filePath);
  const undoDisabled = history.canUndo ? "" : "disabled";
  const redoDisabled = history.canRedo ? "" : "disabled";
  const undoRevisionId = escapeAttr(history.undoRevisionId || "");
  const redoRevisionId = escapeAttr(history.redoRevisionId || "");
  return `
    <div class="file-change-controls">
      <button class="file-change-btn" type="button" data-file-history-action="undo" data-file-history-key="${safeKey}" data-file-path="${safePath}" data-revision-id="${undoRevisionId}" ${undoDisabled}>Cofnij</button>
      <button class="file-change-btn" type="button" data-file-history-action="redo" data-file-history-key="${safeKey}" data-file-path="${safePath}" data-revision-id="${redoRevisionId}" ${redoDisabled}>Przywróć</button>
    </div>
  `;
}

function createFileChangeBlock(change = {}) {
  const wrap = document.createElement("div");
  wrap.className = "file-change-item";
  const controlsHtml = buildFileHistoryControlsHtml(change.history, change.path || "");
  const summaryHtml = `
    <div class="file-change-head">
      <span class="file-change-action">${escapeHtml(fileChangeActionLabel(change.action))}</span>
      <span class="file-change-path">${escapeHtml(change.path || "")}</span>
      <div class="file-change-meta">
        <span class="file-change-stats">
          <span class="diff-stat-plus">+{{added}}</span>
          <span class="diff-stat-minus">-{{removed}}</span>
        </span>
        ${controlsHtml}
        <span class="diff-toggle-hint">podgląd zmian</span>
      </div>
    </div>
  `;
  const details = buildDiffDetailsElement(Array.isArray(change.diff) ? change.diff : [], {
    open: false,
    summaryHtml,
    summaryClass: "diff-summary file-change-summary",
  });
  wrap.appendChild(details);
  return wrap;
}

function toolVisualKind(tool) {
  if (tool === "write_file" || tool === "patch_edit" || tool === "patch_batch") return "write";
  if (tool === "read_file" || tool === "ls" || tool === "pwd" || tool === "cd") return "read";
  if (tool === "run_powershell") return "shell";
  if (tool === "fetch_url" || tool === "extract_media" || tool === "download_file") return "search";
  if (tool === "mkdir") return "folder";
  return "work";
}

function buildToolChip(text, tone = "") {
  const clean = String(text || "").trim();
  if (!clean) return "";
  return `<span class="tool-chip ${tone ? `tool-chip--${escapeAttr(tone)}` : ""}">${escapeHtml(clean)}</span>`;
}

function buildCodePreviewDetails(summary, content, maxChars = 3200) {
  const text = String(content || "");
  if (!text.trim()) return "";
  const truncated = text.length > maxChars;
  const preview = truncated ? `${text.slice(0, maxChars)}\n...` : text;
  return `
    <details class="tool-preview-details">
      <summary>${escapeHtml(summary)}${truncated ? " · skrócone" : ""}</summary>
      <pre class="tool-preview-code">${escapeHtml(preview)}</pre>
    </details>
  `;
}

function buildToolPrimaryHtml(tool, args = {}) {
  const visualKind = toolVisualKind(tool);
  const targetRaw = tool === "run_powershell"
    ? String(args.command || "").trim()
    : String(toolSegmentPath(tool, args) || args.path || args.url || args.downloadUrl || "").trim();
  const target = tool === "run_powershell" ? shortenMiddle(targetRaw, 110) : compactPath(targetRaw, 2);
  const chips = [];
  let line = "Pracuję";
  let previewHtml = "";

  if (tool === "write_file") {
    const stats = textStats(args.content || "");
    line = `Kreślę ${fileNameFromPath(args.path)}`;
    chips.push(buildToolChip(`${stats.lines} linii`, "info"));
    chips.push(buildToolChip(formatBytes(stats.bytes), "info"));
    chips.push(buildToolChip((args.mode || "overwrite") === "append" ? "append" : "overwrite"));
    previewHtml = buildCodePreviewDetails("podgląd pisanego pliku", args.content || "");
  } else if (tool === "patch_edit") {
    line = `Szukam i podmieniam w ${fileNameFromPath(args.path)}`;
    chips.push(buildToolChip("SEARCH/REPLACE", "info"));
    previewHtml = buildCodePreviewDetails("podgląd patcha", `SEARCH\n${args.search || ""}\n\nREPLACE\n${args.replace || ""}`);
  } else if (tool === "patch_batch") {
    const blocks = Array.isArray(args.blocks) ? args.blocks : [];
    line = "Nakładam kilka zmian";
    chips.push(buildToolChip(`${blocks.length || "?"} bloków`, "info"));
    previewHtml = blocks.length
      ? buildCodePreviewDetails("lista zmian", blocks.map((block, idx) => `${idx + 1}. ${block.path || args.defaultPath || "plik"}`).join("\n"), 1200)
      : "";
  } else if (tool === "read_file") {
    line = `Otwieram ${fileNameFromPath(args.path)}`;
    if (args.maxBytes) chips.push(buildToolChip(`limit ${formatBytes(args.maxBytes)}`));
  } else if (tool === "run_powershell") {
    line = "Uruchamiam PowerShell";
    if (args.timeout) chips.push(buildToolChip(`${args.timeout} ms`));
    if (args.cwd) chips.push(buildToolChip(`cwd ${compactPath(args.cwd, 2)}`));
  } else if (tool === "ls") {
    line = `Skanuję ${target || "."}`;
  } else if (tool === "mkdir") {
    line = `Tworzę ${fileNameFromPath(args.path)}`;
  } else if (tool === "fetch_url") {
    line = "Pobieram tekst strony";
  } else if (tool === "download_file") {
    line = `Pobieram ${fileNameFromPath(args.path || args.url)}`;
  } else if (tool === "extract_media") {
    line = "Wyciągam media ze strony";
  } else {
    line = `Wykonuję ${tool || "narzędzie"}`;
    if (args && Object.keys(args).length) previewHtml = buildCodePreviewDetails("argumenty", compactJsonPreview(args), 1800);
  }

  return `
    <div class="tool-run-placeholder tool-compact" data-tool-state="${escapeAttr(visualKind)}">
      <div class="tool-compact-row">
        <span class="tool-inline-visual" aria-hidden="true"></span>
        <span class="tool-inline-copy">
          <span class="tool-inline-main">${escapeHtml(line)}</span>
          ${target && tool !== "ls" ? `<span class="tool-inline-target" title="${escapeAttr(targetRaw)}">${escapeHtml(target)}</span>` : ""}
        </span>
        ${chips.length ? `<span class="tool-inline-metrics">${chips.join("")}</span>` : ""}
      </div>
      ${previewHtml}
    </div>
  `;
}

function buildResultCompactHtml(label, chips = [], details = "") {
  return `
    <div class="tool-result-compact">
      <span class="tool-result-label">${escapeHtml(label)}</span>
      ${chips.length ? `<span class="tool-inline-metrics">${chips.join("")}</span>` : ""}
    </div>
    ${details || ""}
  `;
}

function buildReadFileResultHtml(result = {}) {
  const content = String(result.content || "");
  const stats = textStats(content);
  const chips = [
    buildToolChip(`${stats.lines} linii`, "info"),
    buildToolChip(formatBytes(stats.bytes), "info"),
    result.truncated ? buildToolChip("skrócone", "warn") : "",
  ].filter(Boolean);
  return buildResultCompactHtml(
    "",
    chips,
    "",
  );
}

function buildShellResultHtml(result = {}) {
  const exitCode = Number(result.exitCode);
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  const snippet = [
    result.cwd ? `[cwd] ${result.cwd}` : "",
    stdout ? `[stdout]\n${stdout}` : "",
    stderr ? `[stderr]\n${stderr}` : "",
  ].filter(Boolean).join("\n\n");
  const chips = [
    Number.isFinite(exitCode) ? buildToolChip(`exit ${exitCode}`, exitCode === 0 ? "ok" : "warn") : "",
    stdout ? buildToolChip("stdout", "info") : "",
    stderr ? buildToolChip("stderr", "warn") : "",
  ].filter(Boolean);
  return buildResultCompactHtml(
    "",
    chips,
    "",
  );
}

function buildGenericResultHtml(result = {}) {
  return buildResultCompactHtml(
    "",
    [],
    "",
  );
}

function ensureInlineEventExpand(el) {
  if (!el) return null;
  const detailWrap = el.querySelector(".inline-event-detail-wrap");
  if (!detailWrap) return null;
  let expand = detailWrap.querySelector(".inline-event-expand");
  if (!expand) {
    expand = document.createElement("div");
    expand.className = "inline-event-expand";
    detailWrap.appendChild(expand);
  }
  return expand;
}

function appendInlineEventExpandHtml(el, html = "") {
  const expand = ensureInlineEventExpand(el);
  if (!expand || !String(html || "").trim()) return;
  expand.insertAdjacentHTML("beforeend", html);
  el.classList.add("inline-event--has-detail");
  const summaryBtn = el.querySelector(".inline-event-summary");
  if (summaryBtn) {
    summaryBtn.disabled = false;
    summaryBtn.classList.remove("no-detail");
  }
  syncInlineEventPersistAttrs(el);
}

function appendJsonDetails(el, payload) {
  appendInlineEventExpandHtml(
    el,
    `<pre class="tool-result-snippet">${escapeHtml(compactJsonPreview(payload))}</pre>`,
  );
}

function createToolCardSegment(event) {
  const label = toolActionLabel(event.tool, event.args);
  const el = addInlineEvent("tool", label, "", "", {
    variant: "toolcard",
    primaryHtml: buildToolPrimaryHtml(event.tool, event.args || {}),
    eventAt: event.at,
    defaultExpanded: false,
    showDuration: true,
    duration: "00:00",
  });
  const segment = {
    key: `tool-${event.tool || "unknown"}-${event.id || Date.now()}`,
    tool: event.tool,
    path: toolSegmentPath(event.tool, event.args),
    startedAtMs: parseEventTimeMs(event),
    el,
  };
  return segment;
}

function syncFileHistoryControls(filePath, history = {}) {
  const key = historyKeyFromPath(filePath);
  if (!key || !conversation) return;
  conversation.querySelectorAll(`button[data-file-history-key="${CSS.escape(key)}"]`).forEach((button) => {
    const action = button.getAttribute("data-file-history-action");
    const isUndo = action === "undo";
    const enabled = isUndo ? history.canUndo === true : history.canRedo === true;
    button.disabled = !enabled;
    button.setAttribute("data-revision-id", isUndo ? String(history.undoRevisionId || "") : String(history.redoRevisionId || ""));
  });
}

function upsertFileChangeEvent(event) {
  const change = {
    path: String(event.path || ""),
    action: event.action || "change",
    diff: Array.isArray(event.diff) ? event.diff : [],
    at: event.at || new Date().toISOString(),
    history: event.history || null,
  };
  currentFileChanges.push(change);

  if (change.history) {
    syncFileHistoryControls(change.path, change.history);
  }

  const matchingSegment = findSegmentForFileChange(change);
  if (matchingSegment) {
    mergeFileChangeIntoToolCard(matchingSegment, change);
    if (change.history) syncFileHistoryControls(change.path, change.history);
    return;
  }

  const card = createFileChangeBlock(change);
  addInlineEvent("change", `${fileChangeActionLabel(change.action)}: ${change.path || "plik"}`, "", "", {
    eventAt: event.at,
    defaultExpanded: false,
    primaryHtml: card.outerHTML,
  });
}

function buildWebLookupHtml(event = {}) {
  const sources = Array.isArray(event.sources) ? event.sources : [];
  const visited = Array.isArray(event.visitedUrls) ? event.visitedUrls : [];
  const query = event.lookupQuery || event.query || "";
  const sourceRows = sources
    .filter((source) => source?.url)
    .map((source) => {
      const url = String(source.url || "");
      const label = String(source.title || source.url || "Źródło");
      return `<li><a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a></li>`;
    })
    .join("");
  const visitedRows = visited
    .filter(Boolean)
    .slice(0, 8)
    .map((url) => `<li><a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a></li>`)
    .join("");
  return `
    <div class="web-lookup-compact">
      ${query ? `<div class="web-lookup-query">Zapytanie: <span>${escapeHtml(query)}</span></div>` : ""}
      ${event.detail ? `<div class="web-lookup-detail">${escapeHtml(event.detail)}</div>` : ""}
      ${sourceRows ? `<div class="web-lookup-section"><strong>Źródła</strong><ul>${sourceRows}</ul></div>` : ""}
      ${visitedRows ? `<div class="web-lookup-section"><strong>Odwiedzone</strong><ul>${visitedRows}</ul></div>` : ""}
      ${event.lookupUrl ? `<div class="web-lookup-url">API: ${escapeHtml(event.lookupUrl)}</div>` : ""}
    </div>
  `;
}

function upsertWebLookupEvent(event = {}) {
  const sources = Array.isArray(event.sources) ? event.sources.filter((source) => source?.url) : [];
  const visited = Array.isArray(event.visitedUrls) ? event.visitedUrls.filter(Boolean) : [];
  const hasUsefulDetail = event.used || sources.length || visited.length || event.lookupQuery || event.lookupUrl;
  if (!hasUsefulDetail) return;

  const title = event.used
    ? `Web lookup · ${sources.length || visited.length || 1} źródł${(sources.length || visited.length || 1) === 1 ? "o" : "a"}`
    : "Web lookup · bez mocnego wyniku";
  const extraHtml = buildWebLookupHtml(event);
  if (!currentWebLookupEvent || !currentWebLookupEvent.isConnected) {
    currentWebLookupEvent = addInlineEvent("activity", title, "", extraHtml, {
      eventAt: event.at,
      defaultExpanded: false,
    });
    currentWebLookupEvent.setAttribute("data-activity-id", `web-lookup-${event.id || Date.now()}`);
    return;
  }

  const titleEl = currentWebLookupEvent.querySelector(".inline-event-title");
  if (titleEl) titleEl.textContent = title;
  currentWebLookupEvent.setAttribute("data-title", title);
  currentWebLookupEvent.setAttribute("data-extra-html", extraHtml);
  const expandEl = currentWebLookupEvent.querySelector(".inline-event-expand");
  if (expandEl) expandEl.innerHTML = extraHtml;
  syncInlineEventPersistAttrs(currentWebLookupEvent);
  smartScroll();
}

function findSegmentForFileChange(event) {
  const p = normalizePathForMatch(event.path);
  for (let i = activeToolSegments.length - 1; i >= 0; i--) {
    const seg = activeToolSegments[i];
    if (!seg?.el?.classList.contains("inline-event--toolcard")) continue;
    if (seg.tool === "patch_batch") return seg;
    const mergeTools = new Set(["write_file", "patch_edit", "download_file"]);
    if (mergeTools.has(seg.tool) && normalizePathForMatch(seg.path) === p) return seg;
  }
  return null;
}

function mergeFileChangeIntoToolCard(segment, event) {
  const primary = segment.el.querySelector(".inline-event-primary");
  if (!primary) return;
  const ph = primary.querySelector(".tool-run-placeholder");
  if (ph) ph.remove();
  let bucket = primary.querySelector(".tool-file-changes");
  if (!bucket) {
    bucket = document.createElement("div");
    bucket.className = "tool-file-changes";
    primary.innerHTML = "";
    primary.appendChild(bucket);
  }
  const blockWrap = document.createElement("div");
  blockWrap.className = "tool-file-change-block tool-file-change-block--inline";
  blockWrap.appendChild(createFileChangeBlock(event));
  bucket.appendChild(blockWrap);
  if (event.history) syncFileHistoryControls(event.path, event.history);
  syncInlineEventPersistAttrs(segment.el);
}

function finalizeToolCardSuccess(segment, event) {
  const el = segment?.el;
  if (!el || !el.classList.contains("inline-event--toolcard")) return false;
  const tool = event.tool;
  const result = event.result || {};
  const titleEl = el.querySelector(".inline-event-title");
  const primary = el.querySelector(".inline-event-primary");
  const detailEl = el.querySelector(".inline-event-detail");

  const ph = primary?.querySelector(".tool-run-placeholder");
  if (ph) ph.remove();

  if (tool === "read_file") {
    if (titleEl) titleEl.textContent = `Odczytano: ${compactPath(result.path || segment.path || "", 2)}`;
    if (primary) {
      primary.innerHTML = buildReadFileResultHtml(result);
    }
    if (detailEl) detailEl.textContent = "";
  } else if (tool === "run_powershell") {
    const exitCode = Number(result.exitCode);
    if (titleEl) {
      titleEl.textContent = Number.isFinite(exitCode)
        ? `Polecenie zakończone · exit ${exitCode}`
        : "Polecenie zakończone";
    }
    if (primary) {
      const stdout = String(result.stdout || "").trim();
      const stderr = String(result.stderr || "").trim();
      primary.innerHTML = buildShellResultHtml({ ...result, stdout, stderr });
    }
    if (detailEl) detailEl.textContent = "";
  } else if (tool === "patch_edit" || tool === "write_file" || tool === "patch_batch" || tool === "download_file") {
    const labels = {
      patch_edit: "Zastosowano zmiany",
      write_file: "Zapisano plik",
      patch_batch: "Zastosowano paczkę patchy",
      download_file: "Pobrano plik",
    };
    el.classList.add("inline-event--file-action");
    if (titleEl) {
      if (tool === "patch_batch" && Number.isFinite(Number(result.appliedCount))) {
        titleEl.textContent = `${labels.patch_batch} · ${result.appliedCount} plik(ów)`;
      } else {
        const pathHint = result.path || (Array.isArray(result.applied) && result.applied[0]?.path) || segment.path || "";
        titleEl.textContent = pathHint ? `${labels[tool] || "Gotowe"}: ${compactPath(pathHint, 2)}` : (labels[tool] || "Gotowe");
      }
    }
    if (primary && !primary.querySelector(".tool-file-changes")) {
      const pathHint = String(result.path || segment.path || "").trim();
      if (pathHint) {
        const syntheticChange = {
          action: tool,
          path: pathHint,
          diff: Array.isArray(result.diff) ? result.diff : [],
          history: result.history || null,
        };
        const blockWrap = document.createElement("div");
        blockWrap.className = "tool-file-change-block tool-file-change-block--inline";
        blockWrap.appendChild(createFileChangeBlock(syntheticChange));
        primary.innerHTML = `<div class="tool-file-changes"></div>`;
        const bucket = primary.querySelector(".tool-file-changes");
        if (bucket) bucket.appendChild(blockWrap);
      }
    }
    if (detailEl) detailEl.textContent = "";
  } else {
    if (titleEl) titleEl.textContent = `Gotowe: ${tool}`;
    if (primary) {
      primary.innerHTML = buildGenericResultHtml(result);
    }
    if (detailEl) detailEl.textContent = "";
  }

  el.classList.add("inline-event--toolcard-done");
  syncInlineEventPersistAttrs(el);
  return true;
}

function finalizeToolCardError(segment, event) {
  const el = segment?.el;
  if (!el || !el.classList.contains("inline-event--toolcard")) return false;
  const msg = `${event.error || ""}${event.recoveryHint ? `\nObejście: ${event.recoveryHint}` : ""}`;
  el.classList.remove("tool", "inline-event--toolcard", "inline-event--toolcard-done");
  el.classList.add("error", "inline-event--toolcard-error");
  el.setAttribute("data-kind", "error");
  setInlineEventIconKind(el, "error");
  const titleEl = el.querySelector(".inline-event-title");
  if (titleEl) titleEl.textContent = `Błąd: ${event.tool}`;
  const primary = el.querySelector(".inline-event-primary");
  if (primary) {
    primary.innerHTML = buildResultCompactHtml("Błąd narzędzia", [buildToolChip(event.tool || "tool", "warn")], "");
  }
  const detailEl = el.querySelector(".inline-event-detail");
  if (detailEl) detailEl.textContent = "";
  syncInlineEventPersistAttrs(el);
  return true;
}

function extractSourcesFromAnswer(text = "") {
  const raw = String(text || "");
  const marker = raw.match(/(?:^|\n)Źródła:\s*([\s\S]*)$/i);
  if (!marker?.[1]) return [];
  const urls = marker[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter((line) => /^https?:\/\//i.test(line));
  return [...new Set(urls)].slice(0, 12);
}

// ── Thinking Bubble ──
function createThinkingBubble(step = null, options = {}) {
  const stepLabel = step ? `Krok ${step}: ` : "";
  const durationLabel = escapeHtml(options.duration || "00:00");
  const showSpinner = options.showSpinner !== false;
  const bubble = document.createElement("div");
  bubble.className = "thinking-bubble";
  bubble.innerHTML = `
    <button class="thinking-toggle" type="button">
      ${escapeHtml(options.title || `${stepLabel}Myślenie modelu`)} <span class="thinking-duration">${durationLabel}</span>${showSpinner ? ' <span class="thinking-spinner"></span>' : ""}
    </button>
    <div class="thinking-content"></div>
  `;
  if (options.expanded === true) {
    bubble.classList.add("expanded");
    const initContent = bubble.querySelector(".thinking-content");
    if (initContent) {
      initContent.style.maxHeight = "240px";
      initContent.style.opacity = "1";
      initContent.classList.add("expanded");
    }
  }

  bubble.querySelector(".thinking-toggle").addEventListener("click", () => {
    const isExpanded = bubble.classList.contains("expanded");
    const contentEl = bubble.querySelector(".thinking-content");
    if (isExpanded) {
      bubble.classList.remove("expanded");
      if (contentEl) animateCollapse(contentEl, false);
    } else {
      bubble.classList.add("expanded");
      if (contentEl) {
        animateCollapse(contentEl, true);
        contentEl.style.maxHeight = "240px";
      }
    }
  });
  const content = bubble.querySelector(".thinking-content");
  if (content && options.content) content.textContent = String(options.content || "");
  conversation.appendChild(bubble);
  smartScroll();
  updateWelcome();
  return bubble;
}

function appendThinkingText(bubble, text) {
  const content = bubble.querySelector(".thinking-content");
  if (content) {
    content.textContent += text;
    if (bubble.classList.contains("expanded")) content.scrollTop = content.scrollHeight;
    smartScroll();
  }
}

function finalizeThinkingBubble(bubble) {
  const spinner = bubble.querySelector(".thinking-spinner");
  if (spinner) spinner.remove();
  const toggle = bubble.querySelector(".thinking-toggle");
  if (toggle) {
    const content = bubble.querySelector(".thinking-content");
    const lines = (content?.textContent || "").split("\n").filter(Boolean).length;
    const durationText = bubble.querySelector(".thinking-duration")?.textContent || "00:00";
    toggle.innerHTML = `Myślenie modelu · ${lines} linii · ${durationText}`;
  }
}

function restoreThinkingBubble(entry = {}) {
  const bubble = createThinkingBubble(null, {
    title: entry.title || "Myślenie modelu",
    content: entry.content || "",
    duration: entry.duration || "00:00",
    expanded: entry.expanded === true,
    showSpinner: false,
  });
  finalizeThinkingBubble(bubble);
}

function addTotalDurationDivider(durationMs) {
  const divider = document.createElement("div");
  divider.className = "total-duration-divider";
  divider.innerHTML = `<span>Czas modelu ${formatDurationMmSs(durationMs)}</span>`;
  conversation.appendChild(divider);
  smartScroll();
  updateWelcome();
}

// ══════════════ CHAT HISTORY ══════════════
async function loadChatHistory() {
  try {
    chatSessions = await window.endocode.loadChats();
  } catch { chatSessions = []; }
  renderChatHistory();
}

function renderChatHistory() {
  chatHistoryList.innerHTML = "";
  if (chatSessions.length === 0) {
    chatHistoryList.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px 10px;">Brak historii.</div>`;
    return;
  }
  for (const session of chatSessions) {
    const btn = document.createElement("button");
    btn.className = `chat-history-item${session.id === activeChatId ? " active" : ""}`;
    btn.innerHTML = `
      <svg class="chat-item-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 3h10v8H6l-3 2V3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>
      </svg>
      <span class="chat-item-text">${escapeHtml(session.title || "Bez tytułu")}</span>
      <span class="chat-item-time">${timeAgo(session.updatedAt || session.createdAt)}</span>
      <button class="chat-item-delete" title="Usuń">&times;</button>
    `;
    btn.querySelector(".chat-item-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      const wasActive = session.id === activeChatId;
      await window.endocode.deleteChat(session.id);
      await loadChatHistory();
      if (wasActive) {
        if (chatSessions.length > 0) {
          await switchToChat(chatSessions[0].id);
        } else {
          await startNewChat();
        }
      }
    });
    btn.addEventListener("click", () => {
      switchToChat(session.id).catch((e) => addInlineEvent("error", "Czat", e.message || String(e)));
    });
    chatHistoryList.appendChild(btn);
  }
}

async function switchToChat(chatId) {
  activeChatId = chatId;
  conversation.innerHTML = "";
  resetTurnActivity();
  setLiveIdle();
  const session = chatSessions.find((s) => s.id === chatId);
  if (session) {
    let workspaceWarning = "";
    if (session.workspaceRoot) {
      try {
        const state = await window.endocode.restoreWorkspace(session.workspaceRoot);
        applyStateToUi(state);
        if (state.workspaceFallback?.used) {
          workspaceWarning = state.workspaceFallback.message || "wybierz folder na którym pracujemy";
        }
      } catch (e) {
        workspaceWarning = e.message || String(e);
      }
    } else {
      await refreshState();
    }
    await window.endocode.loadChatContext(chatId);
    chatTitle.textContent = session.title || "Czat";
    firstUserMessage = session.title || null;
    // Replay all stored entries
    for (const entry of session.entries || []) {
      if (entry.type === "message") {
        addMessage(entry.role, entry.text);
      } else if (entry.type === "event") {
        const isToolcard = entry.variant === "toolcard";
        addInlineEvent(entry.kind, entry.title, isToolcard ? "" : (entry.body || ""), isToolcard ? "" : (entry.extraHtml || ""), {
          variant: entry.variant || "",
          primaryHtml: entry.primaryHtml || "",
          defaultExpanded: isToolcard ? false : entry.techExpanded === true,
        });
      } else if (entry.type === "thinking") {
        restoreThinkingBubble(entry);
      }
    }
    // Fallback: if no entries but has messages (old format)
    if ((!session.entries || session.entries.length === 0) && session.messages?.length) {
      for (const msg of session.messages) {
        addMessage(msg.role, msg.text);
      }
    }
    if (workspaceWarning) {
      addInlineEvent("error", "Workspace", workspaceWarning);
      await saveChatSession(firstUserMessage);
    }
  }
  renderChatHistory();
  updateWelcome();
}

async function startNewChat() {
  await window.endocode.resetChat();
  const newId = generateId();
  activeChatId = newId;
  firstUserMessage = null;
  promptQueueItems = [];
  promptQueueProcessing = false;
  renderPromptQueue();
  resetTurnActivity();
  setLiveIdle();
  chatTitle.textContent = "Nowy czat";
  conversation.innerHTML = "";
  // Re-add welcome screen
  const ws = document.createElement("div");
  ws.className = "welcome-screen";
  ws.id = "welcomeScreen";
  ws.innerHTML = `
    <div class="welcome-icon">
      <img src="../assets/icon.svg" alt="" width="56" height="56" />
    </div>
    <h2>Co chcesz zbudować?</h2>
    <p class="welcome-sub">Opisz zadanie — EndoCode przeczyta pliki, zaproponuje zmiany i uruchomi komendy.</p>
  `;
  conversation.appendChild(ws);
  currentThinkingBubble = null;
  renderChatHistory();
}

async function saveChatSession(firstMessage = null) {
  const hasUserMessage = Boolean(
    conversation.querySelector(".message.user")?.getAttribute("data-raw-text")
    || conversation.querySelector(".message.user")?.textContent,
  );
  const existingSession = activeChatId
    ? chatSessions.find((session) => session.id === activeChatId)
    : null;
  if (!existingSession && !hasUserMessage) {
    return;
  }
  if (!activeChatId) activeChatId = generateId();
  let state = null;
  try { state = await window.endocode.getState(); } catch { /* ignore */ }
  const title = firstMessage
    ? (firstMessage.length > 50 ? firstMessage.slice(0, 50) + "..." : firstMessage)
    : chatTitle.textContent;

  // Capture ALL conversation entries (messages + inline events)
  const entries = [];
  conversation.querySelectorAll(".message, .inline-event, .thinking-bubble").forEach((el) => {
    if (el.classList.contains("message")) {
      entries.push({
        type: "message",
        role: el.classList.contains("user") ? "user" : "assistant",
        text: el.getAttribute("data-raw-text") ?? el.textContent,
      });
    } else if (el.classList.contains("inline-event")) {
      const expand = el.querySelector(".inline-event-expand");
      const extraFromDom = expand ? expand.innerHTML : (el.getAttribute("data-extra-html") || "");
      const primaryEl = el.querySelector(".inline-event-primary");
      const primaryHtml = primaryEl ? primaryEl.innerHTML : "";
      const techWrap = el.querySelector(".inline-event-detail-wrap");
      const variant = el.getAttribute("data-variant") || "";
      const isToolcard = variant === "toolcard";
      const techExpanded = Boolean(
        !isToolcard
        &&
        techWrap
        && techWrap.classList.contains("expanded")
        && el.getAttribute("data-expanded") === "true",
      );
      const payload = {
        type: "event",
        kind: el.getAttribute("data-kind") || "note",
        title: el.querySelector(".inline-event-title")?.textContent || el.getAttribute("data-title") || "",
        body: isToolcard ? "" : (el.querySelector(".inline-event-detail")?.textContent ?? el.getAttribute("data-body") ?? ""),
        extraHtml: isToolcard ? "" : extraFromDom,
      };
      if (primaryHtml) payload.primaryHtml = primaryHtml;
      if (techExpanded) payload.techExpanded = true;
      if (variant) payload.variant = variant;
      entries.push(payload);
    } else if (el.classList.contains("thinking-bubble")) {
      entries.push({
        type: "thinking",
        title: el.querySelector(".thinking-toggle")?.textContent?.trim() || "Myślenie modelu",
        duration: el.querySelector(".thinking-duration")?.textContent || "00:00",
        content: el.querySelector(".thinking-content")?.textContent || "",
        expanded: el.classList.contains("expanded"),
      });
    }
  });

  const session = {
    id: activeChatId,
    title,
    createdAt: chatSessions.find((s) => s.id === activeChatId)?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceRoot: state?.workspaceRoot || currentWorkspaceRoot,
    entries,
    messages: entries.filter(e => e.type === "message"), // backward compat
  };

  try {
    chatSessions = await window.endocode.saveChat(session);
    renderChatHistory();
  } catch { /* ignore */ }
}

// ══════════════ SYSTEM MONITOR ══════════════
async function updateSystemMonitor() {
  if (document.hidden) return;
  if (updateSystemInFlight) return;
  updateSystemInFlight = true;
  try {
    const info = await window.endocode.getSystemInfo();
    cpuBar.style.width = `${info.cpu}%`;
    cpuValue.textContent = `${info.cpu}%`;
    if (info.gpu >= 0) {
      gpuBar.style.width = `${info.gpu}%`;
      const vendor = info.gpuVendor && info.gpuVendor !== "unknown" ? ` ${String(info.gpuVendor).toUpperCase()}` : "";
      const backend = info.runtimeBackend && info.runtimeBackend !== "unknown" ? ` ${String(info.runtimeBackend).toUpperCase()}` : "";
      gpuValue.textContent = `${info.gpu}%${vendor}${backend}`;
    } else {
      gpuBar.style.width = "0%";
      gpuValue.textContent = info.gpuVendor && info.gpuVendor !== "unknown" ? String(info.gpuVendor).toUpperCase() : "N/A";
    }
    ramBar.style.width = `${info.ramPercent}%`;
    ramValue.textContent = `${info.ramUsedGB}G`;
    if (info.vramPercent >= 0) {
      vramBar.style.width = `${info.vramPercent}%`;
      vramValue.textContent = `${(info.vramUsedMB / 1024).toFixed(1)}G`;
    } else {
      vramBar.style.width = "0%";
      vramValue.textContent = "N/A";
    }
  } catch { /* ignore */ }
  finally { updateSystemInFlight = false; }
}

// ══════════════ CONTEXT INFO ══════════════
async function updateContextInfo() {
  try {
    const info = await window.endocode.getContextInfo();

    const formatTokenLabel = (value) => {
      const n = Number(value || 0);
      if (n < 1000) return `${n}`;
      if (n < 10000) return `${(n / 1000).toFixed(2)}k`;
      return `${(n / 1000).toFixed(1)}k`;
    };

    const tokensLabel = formatTokenLabel(info.estimatedTokens);
    const maxTokensLabel = formatTokenLabel(info.maxTokens);
    contextText.textContent = `${tokensLabel} / ${maxTokensLabel} tok. (${info.messageCount} wiad.)`;

    const percent = Math.min(1, Math.max(0, info.estimatedTokens / (info.maxTokens || 1)));
    const offset = 37.7 - (percent * 37.7);
    const circle = document.getElementById("contextCircle");
    if (circle) {
      circle.style.strokeDashoffset = offset.toFixed(1);
      if (percent > 0.85) {
        circle.style.stroke = "var(--danger)";
      } else if (percent > 0.6) {
        circle.style.stroke = "var(--amber)";
      } else {
        circle.style.stroke = "currentColor";
      }
    }

    if (info.needsRuntimeRestart) {
      const runtimeLabel = formatTokenLabel(info.runtimeMaxTokens);
      const configuredLabel = formatTokenLabel(info.configuredMaxTokens);
      contextIndicator.classList.add("warning");
      contextIndicator.title = `Runtime działa na ${runtimeLabel} tok., a ustawienia mają ${configuredLabel} tok. (wymagany restart runtime).`;
    } else if (info.isNearCompaction) {
      contextIndicator.classList.add("warning");
      contextIndicator.title = "Blisko kompaktowania! (Agresywne skracanie)";
    } else {
      contextIndicator.classList.remove("warning");
      contextIndicator.title = `Kontekst rozmowy: ${info.estimatedTokens} / ${info.maxTokens} tokenów`;
    }
  } catch { /* ignore */ }
}

// ══════════════ ACCESS LEVEL ══════════════
function updateAccessUI(level) {
  currentAccessLevel = level;
  if (level === "full") {
    accessLabel.textContent = "Pełny";
    accessToggle.classList.add("full-access");
    composerAccess.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" stroke-width="1.1"/><path d="M11 7V5a3 3 0 00-6 0v2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg> Pełny dostęp`;
    composerAccess.style.color = "var(--amber)";
  } else {
    accessLabel.textContent = "Sandbox";
    accessToggle.classList.remove("full-access");
    composerAccess.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" stroke-width="1.1"/><path d="M5 7V5a3 3 0 016 0v2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg> Sandbox`;
    composerAccess.style.color = "";
  }
}

// ══════════════ STATE REFRESH ══════════════
function applyStateToUi(state) {
  currentWorkspaceRoot = state.workspaceRoot || "";
  workspaceLabel.textContent = shortPath(state.workspaceRoot);
  composerWsName.textContent = shortPath(state.workspaceRoot);
  if (runtimeWarning) {
    const runtimeMissing = state.runtimeStatus ? !state.runtimeStatus.llamaAvailable : !state.serverExe;
    runtimeWarning.classList.toggle("hidden", !runtimeMissing);
    const backendHint = state.runtimeStatus?.backend && state.runtimeStatus.backend !== "unknown"
      ? `Backend: ${state.runtimeStatus.backend}`
      : "Backend: niezweryfikowany";
    const detail = state.runtimeStatus?.backendDetail ? ` ${state.runtimeStatus.backendDetail}` : "";
    runtimeWarning.title = runtimeMissing
      ? (state.runtimeStatus?.message || "Brak runtime llama.cpp.")
      : `${backendHint}.${detail}`;
    if (installRuntimeBtn) {
      installRuntimeBtn.disabled = !runtimeMissing || runtimeInstallInProgress;
      installRuntimeBtn.textContent = runtimeInstallInProgress ? "Instalowanie..." : "Pobierz i zainstaluj";
    }
    if (runtimeInstallProgress && !runtimeInstallInProgress) {
      runtimeInstallProgress.classList.add("hidden");
      if (runtimeInstallProgressFill) runtimeInstallProgressFill.style.width = "0%";
      if (runtimeInstallProgressText) runtimeInstallProgressText.textContent = "Przygotowanie...";
    }
  }
  renderModelSelect(state);
  renderReasoningSelect(state);
  updateAccessUI(state.accessLevel || "sandbox");
}

async function refreshState() {
  if (document.hidden) return null;
  if (refreshStateInFlight) return null;
  refreshStateInFlight = true;
  try {
    const state = await window.endocode.getState();
    applyStateToUi(state);
    return state;
  } finally {
    refreshStateInFlight = false;
  }
}

function renderModelSelect(state) {
  modelSelect.innerHTML = "";
  const availableModels = (state.models || []).filter((model) => model.available);
  const truncateModelLabel = (value, max = 42) => {
    const text = String(value || "");
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  const applyModelSelectFontSize = (fullLabel = "") => {
    const len = String(fullLabel || "").length;
    modelSelect.classList.remove("model-select-small", "model-select-xsmall");
    if (len > 46) modelSelect.classList.add("model-select-xsmall");
    else if (len > 34) modelSelect.classList.add("model-select-small");
  };

  if (availableModels.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Brak pobranych modeli";
    option.disabled = true;
    option.selected = true;
    modelSelect.appendChild(option);
    modelSelect.disabled = true;
    applyModelSelectFontSize("");
    return;
  }

  modelSelect.disabled = false;
  for (const model of availableModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = truncateModelLabel(model.displayName);
    option.title = model.displayName;
    option.disabled = false;
    option.selected = model.id === state.selectedModelId;
    modelSelect.appendChild(option);
    if (option.selected) applyModelSelectFontSize(model.displayName);
  }
}

function renderReasoningSelect(state) {
  reasoningSelect.innerHTML = "";
  for (const [level, profile] of Object.entries(state.reasoningLevels || {})) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = profile.label;
    option.selected = level === state.selectedReasoning;
    reasoningSelect.appendChild(option);
  }
}

// ══════════════ MODELS ══════════════
function renderModels(models = [], targetEl = modelsList, cacheMap = modelRenderCacheLibrary) {
  modelsModule?.renderModels(models, targetEl, cacheMap);
}

function patchModelDownloadProgress(modelId, progress, downloaded = 0, total = 0) {
  modelsModule?.patchModelDownloadProgress(modelId, progress, downloaded, total);
}

async function loadModels() {
  await modelsModule?.loadModels?.();
  await refreshModelLibraryStats();
}

function formatBytesShort(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

async function refreshModelLibraryStats() {
  if (!modelsLibraryStats) return;
  try {
    const stats = await window.endocode.getModelLibraryStats();
    const count = Number(stats?.installedCount || 0);
    const sizeText = formatBytesShort(stats?.installedBytes || 0);
    const freeText = stats?.diskFreeBytes == null ? "—" : formatBytesShort(stats.diskFreeBytes);
    modelsLibraryStats.textContent = `Modele: ${count} • Rozmiar: ${sizeText} • Wolne: ${freeText}`;
  } catch {
    modelsLibraryStats.textContent = "Modele: — • Rozmiar: — • Wolne: —";
  }
}

function renderApiProviders() {
  if (!modelsApiList) return;
  if (!Array.isArray(apiProvidersState) || !apiProvidersState.length) {
    modelsApiList.innerHTML = `<div class="models-empty">Brak providerów API.</div>`;
    return;
  }
  modelsApiList.innerHTML = apiProvidersState.map((provider) => {
    const label = API_PROVIDER_LABELS[provider.id] || provider.id;
    const enabled = Boolean(provider.enabled);
    const hasKey = Boolean(provider.hasKey);
    const modelsCount = Number(provider.modelsCount || 0);
    const status = enabled
      ? (hasKey ? `włączone • modeli: ${modelsCount}` : "włączone • brak klucza")
      : "wyłączone";
    return `
      <div class="api-provider-card" data-provider-id="${escapeAttr(provider.id)}">
        <div class="api-provider-head">
          <span class="api-provider-name">${escapeHtml(label)}</span>
          <span class="api-provider-state">${escapeHtml(status)}</span>
        </div>
        <div class="api-provider-controls">
          <label class="api-provider-toggle">
            <input type="checkbox" data-role="toggle" ${enabled ? "checked" : ""} />
            Włącz
          </label>
          <input type="password" data-role="api-key" placeholder="Wklej klucz API..." ${enabled ? "" : "disabled"} />
          <button class="modal-btn approve" data-role="refresh" ${enabled ? "" : "disabled"}>Pobierz modele</button>
        </div>
        <div class="api-provider-meta">Klucz jest zapisywany lokalnie. Modele pobierają się po kliknięciu „Pobierz modele”.</div>
        ${provider.lastError ? `<div class="api-provider-error">${escapeHtml(provider.lastError)}</div>` : ""}
      </div>
    `;
  }).join("");
}

async function loadApiProviders() {
  try {
    apiProvidersState = await window.endocode.getApiProviders();
    renderApiProviders();
  } catch (error) {
    modelsApiList.innerHTML = `<div class="models-empty error">${escapeHtml(error.message || String(error))}</div>`;
  }
}

window.useModel = async (modelId) => {
  try {
    setBusy(true);
    const state = await window.endocode.setModel(modelId);
    applyStateToUi(state);
    modelsModal.classList.add("hidden");
    addInlineEvent("note", "Model", `Wybrano ${state.modelConfig.displayName}`);
  } catch (e) {
    addInlineEvent("error", "Model", e.message || String(e));
  } finally {
    setBusy(false);
  }
};

window.downloadModel = async (modelId) => {
  try {
    await window.endocode.downloadModel(modelId);
    await loadModels();
  } catch (e) {
    const msg = String(e?.message || "");
    if (/anulowan|cancel/i.test(msg)) {
      modelsModule?.setModelsStatus?.(`Anulowano pobieranie ${modelId}.`);
    } else {
      alert(`Błąd pobierania: ${e.message}`);
    }
  }
};

window.deleteModel = async (modelId) => {
  if (!confirm(`Czy na pewno usunąć plik modelu ${modelId}?`)) return;
  try {
    await window.endocode.deleteModel(modelId);
    await loadModels();
  } catch (e) {
    alert(`Błąd usuwania: ${e.message}`);
  }
};

window.cancelModelDownload = async (modelId) => {
  try {
    await window.endocode.cancelModelDownload(modelId);
    addInlineEvent("note", "Pobieranie", `Anulowano pobieranie modelu ${modelId}.`);
  } catch (e) {
    addInlineEvent("error", "Pobieranie", e.message || String(e));
  }
};

function formatDownloadSize(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  return `${(value / 1024 / 1024).toFixed(0)} MB`;
}

function downloadEntryLabel(entry = {}) {
  return entry.displayName || entry.fileName || entry.modelId || "model";
}

function downloadStateLabel(state = "") {
  if (state === "queued") return "w kolejce";
  if (state === "downloading") return "pobieranie";
  if (state === "failed") return "błąd";
  if (state === "cancelled") return "anulowano";
  return state || "pobieranie";
}

function renderModelsDownloadInline(items = []) {
  if (!modelsDownloadInline) return;
  if (!items.length) {
    modelsDownloadInline.classList.add("hidden");
    modelsDownloadInline.innerHTML = "";
    return;
  }
  const first = items[0];
  const progress = Math.max(0, Math.min(100, Number(first.progress || 0)));
  const extraCount = items.length > 1 ? ` +${items.length - 1}` : "";
  modelsDownloadInline.classList.remove("hidden");
  modelsDownloadInline.innerHTML = `
    <div class="models-download-inline-title">
      <span>Pobieranie modelu${extraCount}</span>
      <strong>${progress}%</strong>
    </div>
    <div class="download-progress-container compact">
      <div class="download-progress-fill" style="width:${progress}%"></div>
    </div>
    <div class="models-download-inline-name">${escapeHtml(downloadEntryLabel(first))}</div>
    <div class="models-download-inline-actions">
      <button class="model-btn delete" data-download-cancel="${escapeAttr(first.modelId || "")}">Anuluj</button>
    </div>
  `;
}

function renderDownloadCenter() {
  if (!downloadCenter || !downloadCenterList || !downloadCenterCount) return;
  const items = [...modelDownloadState.values()];
  downloadCenterCount.textContent = String(items.length);
  if (!items.length) {
    downloadCenter.classList.add("hidden");
    downloadCenter.classList.add("collapsed");
    if (downloadCenterSummary) downloadCenterSummary.textContent = "Brak aktywnych pobrań.";
    renderModelsDownloadInline([]);
    downloadCenterCollapsed = true;
    return;
  } else {
    downloadCenter.classList.remove("hidden");
  }

  downloadCenter.classList.toggle("collapsed", downloadCenterCollapsed);
  if (downloadCenterToggle) {
    downloadCenterToggle.textContent = downloadCenterCollapsed ? "+" : "−";
    downloadCenterToggle.title = downloadCenterCollapsed ? "Rozwiń pobieranie" : "Zwiń pobieranie";
  }

  const first = items[0];
  const firstProgress = Math.max(0, Math.min(100, Number(first.progress || 0)));
  const firstLabel = downloadEntryLabel(first);
  if (downloadCenterSummary) {
    downloadCenterSummary.innerHTML = `
      <span class="download-center-summary-text">${escapeHtml(firstLabel)}</span>
      <span class="download-center-summary-progress">${firstProgress}%</span>
      <div class="download-progress-container compact">
        <div class="download-progress-fill" style="width:${firstProgress}%"></div>
      </div>
    `;
  }

  downloadCenterList.innerHTML = items.map((entry) => {
    const progress = Number(entry.progress || 0);
    const downloaded = formatDownloadSize(entry.downloaded);
    const total = Number(entry.total || 0) > 0 ? formatDownloadSize(entry.total) : "?? MB";
    const label = downloadEntryLabel(entry);
    return `
      <div class="download-center-item">
        <div class="download-center-item-head">
          <span class="download-center-model">${escapeHtml(label)}</span>
          <span class="download-center-state">${escapeHtml(downloadStateLabel(entry.state))}</span>
        </div>
        <div class="download-progress-container">
          <div class="download-progress-fill" style="width:${Math.max(0, Math.min(100, progress))}%"></div>
        </div>
        <div class="download-center-meta">${downloaded} / ${total}</div>
        <button class="model-btn delete" data-download-cancel="${escapeAttr(entry.modelId)}">Anuluj</button>
      </div>
    `;
  }).join("");
  renderModelsDownloadInline(items);
}

if (downloadCenterToggle) {
  downloadCenterToggle.addEventListener("click", () => {
    downloadCenterCollapsed = !downloadCenterCollapsed;
    renderDownloadCenter();
  });
}

// ══════════════ APPROVAL MODAL ══════════════
function openApproval(request, approvalId) {
  pendingApprovalId = approvalId;
  approvalCwd.textContent = `cwd: ${request.cwd}`;
  approvalCommand.textContent = request.command;
  approvalModal.classList.remove("hidden");
  approvalModal.setAttribute("tabindex", "-1");
  approvalModal.focus();
  approveCommand.focus();
}

async function closeApproval(approved) {
  const approvalId = pendingApprovalId;
  if (!approvalId) return;
  pendingApprovalId = null;
  approveCommand.disabled = true;
  rejectCommand.disabled = true;
  try {
    await window.endocode.approve(approvalId, approved);
    showLive(approved ? "Zatwierdzono" : "Odrzucono", approved ? "Uruchamiam komendę..." : "Komenda anulowana.");
  } catch (e) {
    pendingApprovalId = approvalId;
    addInlineEvent("error", "Zatwierdzenie komendy", e.message || String(e));
    showLive("Błąd zatwierdzenia", e.message || String(e));
    return;
  } finally {
    approveCommand.disabled = false;
    rejectCommand.disabled = false;
  }
  approvalModal.classList.add("hidden");
}

// ══════════════ EVENT LISTENERS ══════════════
approveCommand.addEventListener("click", () => closeApproval(true));
rejectCommand.addEventListener("click", () => closeApproval(false));
approvalModal.addEventListener("keydown", (event) => {
  if (approvalModal.classList.contains("hidden")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeApproval(false);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    closeApproval(true);
  }
});

chooseWorkspaceBtn.addEventListener("click", async () => {
  const state = await window.endocode.selectWorkspace();
  applyStateToUi(state);
  await saveChatSession(firstUserMessage);
});

newChatBtn.addEventListener("click", () => startNewChat());

modelsBtn.addEventListener("click", async () => {
  modelsModal.classList.remove("hidden");
  await loadModels();
  await loadApiProviders();
});
closeModels.addEventListener("click", () => modelsModal.classList.add("hidden"));

if (addHfModel) {
  addHfModel.addEventListener("click", async () => {
    const url = hfModelUrl.value.trim();
    if (!url) return;
    addHfModel.disabled = true;
    try {
      const added = await window.endocode.addCustomModel(url);
      hfModelUrl.value = "";
      if (added?.model?.id) void window.downloadModel(added.model.id);
      addInlineEvent("note", "Pobieranie", `Rozpoczęto pobieranie ${added?.model?.displayName || "modelu"}. Wpis w katalogu pojawi się po ukończeniu.`);
    } catch (e) {
      alert(e.message);
    } finally {
      addHfModel.disabled = false;
    }
  });
}

if (modelsApiList) {
  modelsApiList.addEventListener("change", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.dataset.role !== "toggle") return;
    const card = target.closest(".api-provider-card");
    const providerId = card?.dataset?.providerId;
    if (!providerId) return;
    try {
      await window.endocode.updateApiProvider({ providerId, enabled: target.checked });
      await loadApiProviders();
      await loadModels();
    } catch (error) {
      addInlineEvent("error", "API", error.message || String(error));
      await loadApiProviders();
    }
  });

  modelsApiList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const actionBtn = target.closest("button[data-role='refresh']");
    if (!actionBtn) return;
    const card = actionBtn.closest(".api-provider-card");
    const providerId = card?.dataset?.providerId;
    const keyInput = card?.querySelector("input[data-role='api-key']");
    const apiKey = keyInput instanceof HTMLInputElement ? keyInput.value.trim() : "";
    if (!providerId) return;
    actionBtn.setAttribute("disabled", "disabled");
    try {
      if (apiKey) {
        await window.endocode.updateApiProvider({ providerId, apiKey });
      }
      await window.endocode.refreshApiProviderModels(providerId);
      await loadApiProviders();
      await loadModels();
      addInlineEvent("note", "API", `Odświeżono modele: ${API_PROVIDER_LABELS[providerId] || providerId}`);
    } catch (error) {
      addInlineEvent("error", "API", error.message || String(error));
      await loadApiProviders();
    } finally {
      actionBtn.removeAttribute("disabled");
    }
  });
}

if (downloadCenterList) {
  downloadCenterList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const cancelBtn = target.closest("button[data-download-cancel]");
    if (!cancelBtn) return;
    const modelId = cancelBtn.getAttribute("data-download-cancel");
    if (!modelId) return;
    await window.cancelModelDownload(modelId);
  });
}

if (modelsDownloadInline) {
  modelsDownloadInline.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const cancelBtn = target.closest("button[data-download-cancel]");
    if (!cancelBtn) return;
    const modelId = cancelBtn.getAttribute("data-download-cancel");
    if (!modelId) return;
    await window.cancelModelDownload(modelId);
  });
}

accessToggle.addEventListener("click", async () => {
  const newLevel = currentAccessLevel === "sandbox" ? "full" : "sandbox";
  try {
    const result = await window.endocode.setAccessLevel(newLevel);
    updateAccessUI(result.accessLevel);
  } catch (e) {
    addInlineEvent("error", "Błąd dostępu", e.message || String(e));
  }
});

modelSelect.addEventListener("change", async () => {
  setBusy(true);
  try {
    const state = await window.endocode.setModel(modelSelect.value);
    renderModelSelect(state);
    renderReasoningSelect(state);
    addInlineEvent("note", "Model", `Wybrano ${state.modelConfig.displayName}`);
  } catch (e) {
    addInlineEvent("error", "Model", e.message || String(e));
    await refreshState();
  } finally {
    setBusy(false);
  }
});

reasoningSelect.addEventListener("change", async () => {
  try {
    const state = await window.endocode.setReasoning(reasoningSelect.value);
    renderReasoningSelect(state);
    addInlineEvent("note", "Tryb", `${state.reasoningLevels[state.selectedReasoning].label}`);
  } catch (e) {
    addInlineEvent("error", "Tryb", e.message || String(e));
    await refreshState();
  }
});

sendBtn.addEventListener("click", async (event) => {
  if (!appBusy) return;
  event.preventDefault();
  try {
    await window.endocode.abort();
    if (hasStreamingAssistantContent()) {
      finalizeStreamingAssistantMessage("", { overwriteText: false });
      await saveChatSession(firstUserMessage);
    }
  } catch (e) {
    addInlineEvent("error", "Stop", e.message || String(e));
  }
});

killServerBtn.addEventListener("click", async () => {
  killServerBtn.disabled = true;
  showLive("Kill switch...", `Zatrzymuję runtime modelu na porcie 8088`);
  try {
    const result = await window.endocode.killServer();
    const detail = result.alive
      ? `Port ${result.port} nadal odpowiada.`
      : `Port ${result.port} zwolniony${result.killedPids?.length ? `, PID: ${result.killedPids.join(", ")}` : ""}.`;
    addInlineEvent("note", "Kill switch", detail);
    setBusy(false);
    hideLive();
    await refreshState();
  } catch (e) {
    addInlineEvent("error", "Kill switch", e.message || String(e));
  } finally {
    killServerBtn.disabled = false;
  }
});

if (installRuntimeBtn) {
  installRuntimeBtn.addEventListener("click", async () => {
    runtimeInstallInProgress = true;
    installRuntimeBtn.disabled = true;
    installRuntimeBtn.textContent = "Instalowanie...";
    if (runtimeInstallProgress) runtimeInstallProgress.classList.remove("hidden");
    if (runtimeInstallProgressFill) runtimeInstallProgressFill.style.width = "2%";
    if (runtimeInstallProgressText) runtimeInstallProgressText.textContent = "Start instalacji runtime...";
    showLive("Runtime", "Pobieram i instaluje llama.cpp...");
    try {
      const result = await window.endocode.installRuntime();
      if (result?.alreadyInstalled) {
        addInlineEvent("note", "Runtime", "Runtime llama.cpp jest juz zainstalowany.");
      }
      await refreshState();
    } catch (e) {
      addInlineEvent("error", "Runtime", e.message || String(e));
      if (runtimeInstallProgressText) runtimeInstallProgressText.textContent = e.message || String(e);
    } finally {
      hideLive();
      runtimeInstallInProgress = false;
      await refreshState();
    }
  });
}

// ── Auto-resize textarea ──
promptEl.addEventListener("input", () => {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(promptEl.scrollHeight, 180) + "px";
});

// ── Attachments ──
function setFileAttachment(file, dataBase64) {
  currentAttachmentFile = {
    name: file?.name || "plik",
    mimeType: file?.type || "application/octet-stream",
    size: Number(file?.size || 0),
    dataBase64: dataBase64 || "",
  };
  attachmentImage.src = "";
  attachmentImage.classList.add("hidden");
  if (attachmentFileMeta) {
    const kb = Math.max(1, Math.round(currentAttachmentFile.size / 1024));
    attachmentFileMeta.textContent = `${currentAttachmentFile.name} (${kb} KB)`;
    attachmentFileMeta.classList.remove("hidden");
  }
  attachmentPreview.classList.remove("hidden");
}

function clearAttachment() {
  currentAttachmentFile = null;
  attachmentImage.src = "";
  attachmentImage.classList.remove("hidden");
  if (attachmentFileMeta) {
    attachmentFileMeta.textContent = "";
    attachmentFileMeta.classList.add("hidden");
  }
  attachmentPreview.classList.add("hidden");
  fileInput.value = "";
}
attachmentRemove.addEventListener("click", clearAttachment);
attachBtn.addEventListener("click", () => {
  fileInput.click();
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const raw = String(evt?.target?.result || "");
      const idx = raw.indexOf(",");
      resolve(idx >= 0 ? raw.slice(idx + 1) : "");
    };
    reader.onerror = () => reject(new Error("Nie udało się odczytać pliku."));
    reader.readAsDataURL(file);
  });
}

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  fileToBase64(file).then((base64) => setFileAttachment(file, base64)).catch((err) => {
    addInlineEvent("error", "Załącznik", err.message || String(err));
  });
});
promptEl.addEventListener("paste", (e) => {
  const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === "file") {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      fileToBase64(file).then((base64) => setFileAttachment(file, base64)).catch((err) => {
        addInlineEvent("error", "Załącznik", err.message || String(err));
      });
      break;
    }
  }
});

// ── Submit ──
let firstUserMessage = null;

if (promptQueueList) {
  promptQueueList.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-queue-action]");
    if (!target) return;
    const action = target.dataset.queueAction;
    const id = target.dataset.queueId;
    if (!action || !id) return;
    if (action === "up") movePromptInQueue(id, "up");
    else if (action === "down") movePromptInQueue(id, "down");
    else if (action === "edit") editPromptInQueue(id);
    else if (action === "delete") deletePromptFromQueue(id);
    else if (action === "now") void setPromptPriorityNow(id);
  });
}

conversation.addEventListener("click", (event) => {
  const historyTarget = event.target.closest("button[data-file-history-action]");
  if (historyTarget) {
    event.preventDefault();
    event.stopPropagation();
    const action = historyTarget.getAttribute("data-file-history-action");
    const path = historyTarget.getAttribute("data-file-path") || "";
    const revisionId = historyTarget.getAttribute("data-revision-id") || "";
    historyTarget.disabled = true;
    showLive(action === "undo" ? "Cofam zmianę..." : "Przywracam zmianę...", path);
    const promise = action === "undo"
      ? window.endocode.undoFileChange({ path, revisionId })
      : window.endocode.redoFileChange({ path, revisionId });
    void promise.catch((error) => {
      historyTarget.disabled = false;
      addInlineEvent("error", action === "undo" ? "Undo pliku" : "Redo pliku", error.message || String(error));
    }).finally(() => {
      hideLive();
    });
    return;
  }
  const target = event.target.closest("button[data-quick-choice]");
  if (!target) return;
  const mode = target.getAttribute("data-quick-choice");
  if (mode === "preset") {
    const prompt = target.getAttribute("data-choice-prompt") || "";
    target.disabled = true;
    void submitQuickChoicePrompt(prompt);
    return;
  }
  if (mode === "other") {
    const custom = window.prompt("Wpisz własny kierunek:", "");
    if (custom === null) return;
    const trimmed = String(custom).trim();
    if (!trimmed) return;
    target.disabled = true;
    void submitQuickChoicePrompt(trimmed);
  }
});

if (quickChoicesDock) {
  quickChoicesDock.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-quick-choice]");
    if (!target) return;
    const mode = target.getAttribute("data-quick-choice");
    if (mode === "preset") {
      const prompt = target.getAttribute("data-choice-prompt") || "";
      target.disabled = true;
      void submitQuickChoicePrompt(prompt);
      return;
    }
    if (mode === "other") {
      const custom = window.prompt("Wpisz własny kierunek:", "");
      if (custom === null) return;
      const trimmed = String(custom).trim();
      if (!trimmed) return;
      target.disabled = true;
      void submitQuickChoicePrompt(trimmed);
    }
  });
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = promptEl.value.trim();
  const hasAttachment = Boolean(currentAttachmentFile);
  if (!text && !hasAttachment) {
    if (appBusy) {
      try {
        await window.endocode.abort();
      } catch (e) {
        addInlineEvent("error", "Stop", e.message || String(e));
      }
    }
    return;
  }
  if (appBusy) {
    // While model is running, Enter should queue next prompt instead of stopping.
    const attachedFile = currentAttachmentFile ? { ...currentAttachmentFile } : null;
    clearAttachment();
    promptEl.value = "";
    promptEl.style.height = "auto";
    clearQuickChoicesDock();
    const messagePreview = text || (attachedFile ? `[Załączono plik: ${attachedFile.name}]` : "Obraz");
    if (!firstUserMessage) firstUserMessage = messagePreview;
    addMessage("user", messagePreview, null);
    chatTitle.textContent = messagePreview.length > 40 ? messagePreview.slice(0, 40) + "..." : messagePreview;
    await saveChatSession(firstUserMessage);
    addPromptToQueue({ text, attachment: attachedFile });
    promptEl.focus();
    return;
  }
  promptEl.value = "";
  promptEl.style.height = "auto";
  clearQuickChoicesDock();

  const attachedFile = currentAttachmentFile ? { ...currentAttachmentFile } : null;
  clearAttachment();

  const messagePreview = text || (attachedFile ? `[Załączono plik: ${attachedFile.name}]` : "Obraz");
  if (!firstUserMessage) firstUserMessage = messagePreview;
  addMessage("user", messagePreview, null);
  chatTitle.textContent = messagePreview.length > 40 ? messagePreview.slice(0, 40) + "..." : messagePreview;
  await saveChatSession(firstUserMessage);

  const submission = {
    text,
    attachment: attachedFile,
  };

  const hasQueuedWork = promptQueueItems.some((item) => item.status === "queued" || item.status === "running");
  if (!appBusy && !hasQueuedWork) {
    setBusy(true);
    try {
      await sendPromptPayload(submission);
    } catch (e) {
      addInlineEvent("error", "Błąd", e.message || String(e));
      setBusy(false);
      hideLive();
      promptEl.focus();
      await saveChatSession(firstUserMessage);
      await updateContextInfo();
    }
    return;
  }

  addPromptToQueue(submission);
  promptEl.focus();
});

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

// ══════════════ EVENT HANDLER ══════════════
window.endocode.onEvent(async (event) => {
  if (event.type === "status") {
    if (event.status === "model-thinking") showLive("Myśli...", event.detail || "");
    else if (event.status === "model-json-retry") showLive("Naprawiam JSON...", event.detail || "");
    else if (event.status === "model-call-retry") {
      showLive("Restart modelu...", event.detail || "");
    } else if (event.status === "model-action-ready") {
      showLive("Akcja gotowa", event.detail || "");
    } else if (event.status === "model-fallback") {
      showLive("Fallback modelu...", event.detail || "");
      refreshState();
    } else if (event.status === "model-fallback-failed") {
      addInlineEvent("error", "Fallback modelu", event.detail || "Model zapasowy nie wystartował.");
    } else if (event.status === "context-compacted") {
      showLive("Kontekst", event.detail || "");
      updateContextInfo();
    } else if (event.status === "runtime-install") {
      showLive("Instalacja runtime", event.detail || "");
    } else if (event.status === "runtime-install-complete") {
      showLive("Instalacja runtime", event.detail || "");
    } else if (event.status === "action-cooldown") {
      showLive("Recovery", event.detail || "Pauza i korekta planu...");
    } else if (event.status === "server-killing") showLive("Kill switch...", event.detail || "");
    else if (event.status === "server-killed") showLive("Kill switch", event.detail || "");
    else if (event.status === "server-starting" || event.status === "server-stopping") showLive("Runtime modelu", event.detail || "");
    else if (event.status === "download-complete") {
      if (event.modelId) {
        modelDownloadState.delete(event.modelId);
        renderDownloadCenter();
      }
      hideLive();
      loadModels();
    }
    return;
  }
  if (event.type === "chat-web-lookup") {
    const phase = String(event.phase || "");
    if (phase === "start") {
      showLive("Web lookup", event.lookupQuery || "Wyszukiwanie i lekka ekstrakcja danych...");
      return;
    }
    if (phase === "error") {
      showLive("Web lookup: błąd", event.detail || "Błąd pobierania kontekstu internetowego.");
      addInlineEvent("error", "Web lookup", event.detail || "Błąd pobierania kontekstu internetowego.", "", {
        eventAt: event.at,
        defaultExpanded: false,
      });
      return;
    }
    if (phase === "result") {
      const sources = Array.isArray(event.sources) ? event.sources : [];
      const visited = Array.isArray(event.visitedUrls) ? event.visitedUrls : [];
      const sourceLines = sources
        .filter((source) => source?.url)
        .map((source) => `- ${String(source.title || "Źródło")}: ${String(source.url)}`)
        .join("\n");
      const visitedLines = visited.map((url) => `- ${String(url)}`).join("\n");
      const detail = `${event.detail || ""}${event.lookupQuery ? `\nZapytanie po interpretacji: ${event.lookupQuery}` : ""}${event.lookupUrl ? `\nLookup API: ${event.lookupUrl}` : ""}${visitedLines ? `\nOdwiedzone URL:\n${visitedLines}` : ""}${sourceLines ? `\nŹródła użyte w kontekście:\n${sourceLines}` : ""}`.trim();
      showLive(
        event.used ? `Web lookup: użyto${event.fromCache ? " (cache)" : ""}` : "Web lookup: brak trafnych danych",
        (visited[0] || sources[0]?.url || event.lookupQuery || event.lookupUrl || event.detail || "").slice(0, 220),
      );
      upsertWebLookupEvent({ ...event, detail });
      return;
    }
  }
  if (event.type === "model-download-progress") {
    const previous = modelDownloadState.get(event.modelId) || {};
    modelDownloadState.set(event.modelId, {
      ...previous,
      modelId: event.modelId,
      displayName: event.displayName || previous.displayName || "",
      fileName: event.fileName || previous.fileName || "",
      state: "downloading",
      progress: event.progress,
      downloaded: event.downloaded,
      total: event.total,
    });
    renderDownloadCenter();
    patchModelDownloadProgress(event.modelId, event.progress, event.downloaded, event.total);
    return;
  }
  if (event.type === "model-download-state") {
    if (event.state === "queued" || event.state === "downloading") {
      const previous = modelDownloadState.get(event.modelId) || {};
      modelDownloadState.set(event.modelId, {
        ...previous,
        modelId: event.modelId,
        displayName: event.displayName || previous.displayName || "",
        fileName: event.fileName || previous.fileName || "",
        state: event.state,
        progress: event.progress || 0,
        downloaded: event.downloaded || 0,
        total: event.total || 0,
      });
    } else {
      modelDownloadState.delete(event.modelId);
    }
    renderDownloadCenter();
    await loadModels();
    return;
  }
  if (event.type === "runtime-install-progress") {
    const pct = Math.max(0, Math.min(100, Number(event.progress) || 0));
    if (runtimeInstallProgress) runtimeInstallProgress.classList.remove("hidden");
    if (runtimeInstallProgressFill) runtimeInstallProgressFill.style.width = `${pct}%`;
    if (runtimeInstallProgressText) runtimeInstallProgressText.textContent = event.detail || `Instalacja runtime: ${pct}%`;
    return;
  }
  if (event.type === "parse-error") {
    addInlineEvent("error", "Model JSON", `Niepoprawna odpowiedź (${event.attempt}/${event.maxAttempts}): ${event.error || ""}`);
    showLive("Naprawiam odpowiedź modelu...");
    return;
  }
  if (event.type === "workspace-missing") {
    addInlineEvent("error", "Workspace", event.message || "wybierz folder na którym pracujemy");
    refreshState();
    return;
  }
  if (event.type === "run-start") {
    finalReceivedInRun = false;
    activeRunStartedAtMs = parseEventTimeMs(event);
    stopAllLiveDurations();
    currentThinkingSegment = null;
    activeToolSegments.length = 0;
    lastAgentPhaseSignature = "";
    agentPhaseHistoryLines = [];
    resetTurnActivity();
    removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
    clearLiveDetails();
    const rawInput = String(event.text || "").trim();
    const shortInput = rawInput.length > 240 ? `${rawInput.slice(0, 240)}...` : rawInput;
    showMiniStatus("Startuję zadanie...");
    pushLiveEntry("phase", "Startuję zadanie", shortInput || "Przygotowuję kontekst i pierwszy krok.", { active: true, eventAt: event.at });
    return;
  }
  if (event.type === "run-end") {
    stopAllLiveDurations();
    activeToolSegments.length = 0;
    currentThinkingSegment = null;
    lastAgentPhaseSignature = "";
    removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
    clearLiveDraft();
    if (Number.isFinite(activeRunStartedAtMs)) {
      pushLiveEntry("phase", "Zadanie zakończone", `Czas: ${formatDurationMmSs(Date.now() - activeRunStartedAtMs)}`, { key: "status-current", eventAt: event.at });
    }
    if (!finalReceivedInRun && hasStreamingAssistantContent()) {
      finalizeStreamingAssistantMessage("", { overwriteText: false });
    }
    setBusy(false);
    hideMiniStatus();
    currentThinkingBubble = null;
    activeRunStartedAtMs = null;
    updateContextInfo();
    return;
  }
  if (event.type === "note") {
    removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
    const noteText = String(event.note || "").trim();
    const shortNote = noteText.length > 90 ? `${noteText.slice(0, 90)}...` : noteText;
    showMiniStatus(shortNote || "Plan...");
    pushLiveEntry("phase", "Notatka agenta", noteText, { eventAt: event.at });
    return;
  }
  if (event.type === "agent-phase") {
    const phase = String(event.phase || "");
    const phaseLabel = friendlyAgentPhaseLabel(phase, event);
    const detail = friendlyAgentPhaseDetail(event);
    const signature = `${phase}|${event.step || ""}|${detail}`;
    if (signature !== lastAgentPhaseSignature) {
      lastAgentPhaseSignature = signature;
      const line = `${event.step ? `krok ${event.step}` : "teraz"} · ${phaseLabel}${detail ? ` · ${detail}` : ""}`;
      agentPhaseHistoryLines.push(line);
      if (agentPhaseHistoryLines.length > 10) agentPhaseHistoryLines = agentPhaseHistoryLines.slice(-10);
      // Only mini-status + live panel, no inline events in chat
      const statusLabel = event.step ? `Krok ${event.step}: ${phaseLabel}` : phaseLabel;
      showMiniStatus(statusLabel);
      pushLiveEntry("phase", statusLabel, detail || "Przetwarzanie", { key: `phase-${event.step || "now"}`, active: true, eventAt: event.at });
    }
    return;
  }
  if (event.type === "model-raw") {
    // Push raw JSON to live details panel instead of skipping
    const rawText = typeof event.raw === "string" ? event.raw : JSON.stringify(event.raw || event, null, 2);
    pushLiveEntry("json", "Model JSON", rawText.slice(0, 5000));
    return;
  }
  if (event.type === "thinking-start") {
    if (!SHOW_MODEL_THINKING_TRACE) {
      showLive(event.step ? `Krok ${event.step}: Myślenie...` : "Model myśli...");
      return;
    }
    const startedAtMs = parseEventTimeMs(event);
    currentThinkingBubble = createThinkingBubble(event.step);
    const durationEl = currentThinkingBubble.querySelector(".thinking-duration");
    const segmentKey = `thinking-${event.step ?? "default"}-${event.id || Date.now()}`;
    if (durationEl) startLiveDuration(segmentKey, startedAtMs, durationEl);
    currentThinkingSegment = { key: segmentKey, startedAtMs };
    showLive(event.step ? `Krok ${event.step}: Myślenie...` : "Model myśli...");
    return;
  }

  if (event.type === "thinking-delta") {
    if (!SHOW_MODEL_THINKING_TRACE) {
      const stepLabel = event.step ? `Krok ${event.step}: ` : "";
      showLive(`${stepLabel}Myślenie...`);
      return;
    }
    if (currentThinkingBubble) appendThinkingText(currentThinkingBubble, event.text);
    const lastLine = (event.full || "").split("\n").filter(Boolean).pop() || "";
    const stepLabel = event.step ? `Krok ${event.step}: ` : "";
    showLive(`${stepLabel}Myślenie...`, lastLine.slice(0, 120));
    return;
  }

  if (event.type === "thinking-end") {
    if (!SHOW_MODEL_THINKING_TRACE) return;
    if (currentThinkingBubble) {
      const content = currentThinkingBubble.querySelector(".thinking-content");
      const hasContent = Boolean(content && String(content.textContent || "").trim());
      if (!hasContent && typeof event.full === "string" && event.full.trim()) {
        appendThinkingText(currentThinkingBubble, event.full);
      }
      if (currentThinkingSegment?.key) stopLiveDuration(currentThinkingSegment.key, parseEventTimeMs(event));
      finalizeThinkingBubble(currentThinkingBubble);
      currentThinkingBubble = null;
      currentThinkingSegment = null;
    }
    return;
  }
  if (event.type === "content-delta") {
    const full = event.full || "";
    const preview = full.trim().slice(0, 50000);
    
    const livePhrase = event.plainChat ? "Pisze…" : "Planuje akcję...";
    const planningLine = preview
      .split("\n")
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .pop() || "";

    if (event.plainChat) {
      removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
      clearLiveDraft();
      updateStreamingAssistantMessage(event.text || "", full);
      showMiniStatus(livePhrase);
      return;
    }

    if (preview) {
      const liveFinal = extractLiveAnswerFromDelta(full);
      if (liveFinal) {
        removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
        updateStreamingAssistantMessage("", liveFinal);
        showMiniStatus("Pisze…");
        return;
      }
    }
    const planningDetail = compactModelDraftPreview(full, planningLine || (event.step ? `Krok ${event.step}` : "Pracuje nad akcją"));
    showMiniStatus(livePhrase);
    updateLiveDraft(event.step ? `Krok ${event.step}: model układa akcję` : "Model układa akcję", planningDetail.slice(0, 900));
    return;
  }

  if (event.type === "tool-start") {
    removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
    clearLiveDraft();
    const segment = createToolCardSegment(event);
    const durationEl = segment.el.querySelector(".inline-event-duration");
    if (durationEl) startLiveDuration(segment.key, segment.startedAtMs, durationEl);
    activeToolSegments.push(segment);
    showMiniStatus(toolActionLabel(event.tool, event.args));
    pushLiveEntry("tool", toolActionLabel(event.tool, event.args), toolActionDetail(event.tool, event.args, event.note || "") || shortPath(segment.path) || segment.path || "", { key: segment.key, active: true, eventAt: event.at });
    return;
  }
  if (event.type === "tool-result") {
    const segment = activeToolSegments.pop();
    if (segment?.key) stopLiveDuration(segment.key, parseEventTimeMs(event));
    if (!event.ok) {
      if (!finalizeToolCardError(segment, event)) {
        addInlineEvent("error", `Błąd: ${event.tool}`, "", "", {
          eventAt: event.at,
          defaultExpanded: false,
        });
      }
      showMiniStatus(`Błąd: ${event.tool}`);
      pushLiveEntry("error", `Błąd: ${event.tool}`, toolResultDetailForLive(event.tool, event.result || {}, event), { key: segment?.key || "", eventAt: event.at });
    } else {
      finalizeToolCardSuccess(segment, event);
      showMiniStatus(`Gotowe: ${event.tool}`);
      pushLiveEntry("tool", `Gotowe: ${event.tool}`, toolResultDetailForLive(event.tool, event.result || {}, event) || compactToolResultSummary(event.tool, event.result || {}), { key: segment?.key || "", eventAt: event.at });
    }
    return;
  }
  if (event.type === "file-change") {
    upsertFileChangeEvent(event);
    showLive(`${fileChangeActionLabel(event.action)}: ${event.path}`);
    return;
  }
  if (event.type === "approval-request") {
    openApproval(event.request, event.approvalId);
    showLive("Czeka na zatwierdzenie", event.request?.command || "");
    return;
  }
  if (event.type === "final") {
    finalReceivedInRun = true;
    removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
    clearLiveDraft();
    if (hasStreamingAssistantContent()) {
      finalizeStreamingAssistantMessage(event.text || "");
    } else if (String(event.text || "").trim()) {
      addMessage("assistant", event.text);
    }
    const sources = extractSourcesFromAnswer(event.text || "");
    if (sources.length) {
      addInlineEvent("activity", "Źródła", sources.map((url) => `- ${url}`).join("\n"), "", {
        eventAt: event.at,
        defaultExpanded: false,
      });
    }
    if (Number.isFinite(activeRunStartedAtMs)) {
      pushLiveEntry("phase", "Odpowiedź gotowa", `Czas: ${formatDurationMmSs(Date.now() - activeRunStartedAtMs)}`, { key: "status-current", eventAt: event.at });
    }
    activeRunStartedAtMs = null;
    hideMiniStatus();
    saveChatSession(firstUserMessage);
  }
  if (event.type === "quick-choices") {
    renderQuickChoicesDock(event);
    return;
  }
});

// ══════════════ INIT ══════════════
async function init() {
  await refreshState();
  await loadChatHistory();
  await updateSystemMonitor();
  await updateContextInfo();
}

init();

// Polling
setInterval(() => { if (!appBusy) refreshState(); }, 12000);
setInterval(updateSystemMonitor, 4500);
setInterval(() => { if (appBusy && !document.hidden) updateContextInfo(); }, 4500);

// ══════════════ SETTINGS MODAL ══════════════
const SETTINGS_FIELDS = [
  { id: "temperature", slider: "set_temperature", display: "val_temperature", decimals: 2 },
  { id: "maxTokens", slider: "set_maxTokens", display: "val_maxTokens", decimals: 0 },
  { id: "maxSteps", slider: "set_maxSteps", display: "val_maxSteps", decimals: 0, formatFn: (v) => v == 0 ? "∞" : String(v) },
  { id: "topP", slider: "set_topP", display: "val_topP", decimals: 2 },
  { id: "topK", slider: "set_topK", display: "val_topK", decimals: 0 },
  { id: "repeatPenalty", slider: "set_repeatPenalty", display: "val_repeatPenalty", decimals: 2 },
  {
    id: "contextTokens",
    slider: "set_contextTokens",
    display: "val_contextTokens",
    decimals: 0,
    formatFn: (v) => Number(v).toLocaleString("pl-PL"),
  },
  {
    id: "runtimeContextCap",
    slider: "set_runtimeContextCap",
    display: "val_runtimeContextCap",
    decimals: 0,
    formatFn: (v) => Number(v) <= 0 ? "auto" : Number(v).toLocaleString("pl-PL"),
  },
  { id: "gpuLayers", slider: "set_gpuLayers", display: "val_gpuLayers", decimals: 0 },
  { id: "maxMessages", slider: "set_maxMessages", display: "val_maxMessages", decimals: 0 },
  { id: "threads", slider: "set_threads", display: "val_threads", decimals: 0 },
  { id: "threadsBatch", slider: "set_threadsBatch", display: "val_threadsBatch", decimals: 0 },
  { id: "batchSize", slider: "set_batchSize", display: "val_batchSize", decimals: 0 },
  { id: "ubatchSize", slider: "set_ubatchSize", display: "val_ubatchSize", decimals: 0 },
  { id: "parallel", slider: "set_parallel", display: "val_parallel", decimals: 0 },
  { id: "fastStartup", slider: "set_fastStartup", display: "val_fastStartup", decimals: 0, formatFn: (v) => Number(v) === 1 ? "on" : "off" },
  { id: "flashAttention", slider: "set_flashAttention", display: "val_flashAttention", decimals: 0, formatFn: (v) => Number(v) === 1 ? "on" : "off" },
];
const BASIC_SETTINGS = new Set(["contextTokens", "runtimeContextCap", "gpuLayers", "maxTokens", "maxMessages", "fastStartup"]);
let settingsAdvancedVisible = false;
let cachedRecommendedSettings = null;

function ensureSettingsControls() {
  if (!settingsModal) return;
  if (document.getElementById("toggleAdvancedSettings")) return;
  const header = settingsModal.querySelector(".modal-header");
  if (!header) return;
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.gap = "8px";
  wrap.style.marginLeft = "auto";
  wrap.innerHTML = `
    <button id="applyRecommendedSettings" class="modal-btn" type="button">Optymalne (Auto GPU)</button>
    <button id="toggleAdvancedSettings" class="modal-btn" type="button">Zaawansowane: off</button>
  `;
  const closeBtn = header.querySelector("#closeSettings");
  if (closeBtn) header.insertBefore(wrap, closeBtn);
  else header.appendChild(wrap);
  document.getElementById("toggleAdvancedSettings")?.addEventListener("click", () => {
    settingsAdvancedVisible = !settingsAdvancedVisible;
    applySettingsVisibility();
  });
  document.getElementById("applyRecommendedSettings")?.addEventListener("click", () => {
    if (!cachedRecommendedSettings) return;
    applySettingsToSliders(cachedRecommendedSettings);
    addInlineEvent("note", "Ustawienia", "Załadowano rekomendowane ustawienia pod ten model i sprzęt.");
  });
}

function applySettingsVisibility() {
  const toggle = document.getElementById("toggleAdvancedSettings");
  if (toggle) toggle.textContent = `Zaawansowane: ${settingsAdvancedVisible ? "on" : "off"}`;
  for (const field of SETTINGS_FIELDS) {
    const slider = document.getElementById(field.slider);
    const row = slider?.closest(".setting-row");
    if (!row) continue;
    const isBasic = BASIC_SETTINGS.has(field.id);
    row.classList.toggle("hidden", !isBasic && !settingsAdvancedVisible);
  }
  if (rawModelJson) {
    const rawRow = rawModelJson.closest(".setting-row");
    if (rawRow) rawRow.classList.toggle("hidden", !settingsAdvancedVisible);
  }
}

function applySliderRange(sliderId, range = {}) {
  const slider = document.getElementById(sliderId);
  if (!slider) return;
  const min = Number(range.min);
  const max = Number(range.max);
  const step = Number(range.step);
  if (Number.isFinite(min) && min >= 0) slider.min = String(Math.round(min));
  if (Number.isFinite(max) && max > 0) slider.max = String(Math.round(max));
  if (Number.isFinite(step) && step > 0) slider.step = String(Math.round(step));
}

function applyDynamicTokenLimits(limits = {}) {
  applySliderRange("set_contextTokens", limits.contextTokens);
  applySliderRange("set_runtimeContextCap", { min: 0, max: limits.contextTokens?.max ?? 262144, step: limits.contextTokens?.step ?? 2048 });
  applySliderRange("set_maxTokens", limits.maxTokens);
  applySliderRange("set_maxMessages", limits.maxMessages);
}

// Wire up live value display for all sliders
for (const field of SETTINGS_FIELDS) {
  const slider = document.getElementById(field.slider);
  const display = document.getElementById(field.display);
  if (slider && display) {
    slider.addEventListener("input", () => {
      const val = parseFloat(slider.value);
      display.textContent = field.formatFn ? field.formatFn(val) : (field.decimals > 0 ? val.toFixed(field.decimals) : String(Math.round(val)));
    });
  }
}

function applySettingsToSliders(settings = {}, eff = {}) {
  setSlider("set_temperature", "val_temperature", settings.temperature ?? eff.temperature, 2);
  setSlider("set_maxTokens", "val_maxTokens", settings.maxTokens ?? eff.maxTokens, 0);
  setSlider("set_maxSteps", "val_maxSteps", settings.maxSteps ?? eff.maxSteps, 0, (v) => v == 0 ? "∞" : String(v));
  setSlider("set_topP", "val_topP", settings.topP ?? 1.0, 2);
  setSlider("set_topK", "val_topK", settings.topK ?? 0, 0);
  setSlider("set_repeatPenalty", "val_repeatPenalty", settings.repeatPenalty ?? 1.0, 2);
  setSlider(
    "set_contextTokens",
    "val_contextTokens",
    settings.contextTokens ?? eff.contextTokens,
    0,
    (v) => Number(v).toLocaleString("pl-PL"),
  );
  setSlider(
    "set_runtimeContextCap",
    "val_runtimeContextCap",
    settings.runtimeContextCap ?? eff.runtimeContextCap ?? 0,
    0,
    (v) => Number(v) <= 0 ? "auto" : Number(v).toLocaleString("pl-PL"),
  );
  setSlider("set_gpuLayers", "val_gpuLayers", settings.gpuLayers ?? eff.gpuLayers, 0);
  setSlider("set_maxMessages", "val_maxMessages", settings.maxMessages ?? eff.maxMessages ?? 32, 0);
  setSlider("set_threads", "val_threads", settings.threads ?? eff.threads ?? 8, 0);
  setSlider("set_threadsBatch", "val_threadsBatch", settings.threadsBatch ?? eff.threadsBatch ?? 12, 0);
  setSlider("set_batchSize", "val_batchSize", settings.batchSize ?? eff.batchSize ?? 1024, 0);
  setSlider("set_ubatchSize", "val_ubatchSize", settings.ubatchSize ?? eff.ubatchSize ?? 512, 0);
  setSlider("set_parallel", "val_parallel", settings.parallel ?? eff.parallel ?? 1, 0);
  setSlider("set_fastStartup", "val_fastStartup", (settings.fastStartup ?? eff.fastStartup ?? "on") === "on" ? 1 : 0, 0, (v) => Number(v) === 1 ? "on" : "off");
  setSlider("set_flashAttention", "val_flashAttention", (settings.flashAttention ?? eff.flashAttention ?? "on") === "on" ? 1 : 0, 0, (v) => Number(v) === 1 ? "on" : "off");
}

async function openSettingsModal(modelId = modelSelect.value) {
  try {
    ensureSettingsControls();
    const settings = await window.endocode.getModelSettings(modelId);
    const recommended = await window.endocode.getModelRecommendedSettings(modelId).catch(() => null);
    cachedRecommendedSettings = recommended?.settings || null;
    currentSettingsModelId = settings.modelId || modelId;
    if (settingsModelName) settingsModelName.textContent = `Model: ${settings.modelName || currentSettingsModelId}`;
    const eff = settings._effective || {};
    applyDynamicTokenLimits(settings._limits || {});
    applySettingsToSliders(settings, eff);
    settingsAdvancedVisible = false;
    applySettingsVisibility();
    if (rawModelJson) {
      const raw = await window.endocode.getModelRawConfig(currentSettingsModelId);
      rawModelJson.value = raw.rawJson || "{}";
    }
  } catch { /* ignore */ }
  settingsModal.classList.remove("hidden");
}
window.openSettingsModal = openSettingsModal;

function setSlider(sliderId, displayId, value, decimals, formatFn) {
  const slider = document.getElementById(sliderId);
  const display = document.getElementById(displayId);
  let v = Number(value);
  if (slider && slider.min !== "" && slider.max !== "") {
    const lo = parseFloat(slider.min);
    const hi = parseFloat(slider.max);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      v = Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
    }
  }
  if (slider) slider.value = v;
  if (display) display.textContent = formatFn ? formatFn(v) : (decimals > 0 ? Number(v).toFixed(decimals) : String(Math.round(v)));
}

function collectSettingsFromUI() {
  return {
    temperature: parseFloat(document.getElementById("set_temperature").value),
    maxTokens: parseInt(document.getElementById("set_maxTokens").value, 10),
    maxSteps: parseInt(document.getElementById("set_maxSteps").value, 10),
    topP: parseFloat(document.getElementById("set_topP").value),
    topK: parseInt(document.getElementById("set_topK").value, 10),
    repeatPenalty: parseFloat(document.getElementById("set_repeatPenalty").value),
    contextTokens: parseInt(document.getElementById("set_contextTokens").value, 10),
    runtimeContextCap: parseInt(document.getElementById("set_runtimeContextCap").value, 10),
    gpuLayers: parseInt(document.getElementById("set_gpuLayers").value, 10),
    maxMessages: parseInt(document.getElementById("set_maxMessages").value, 10),
    threads: parseInt(document.getElementById("set_threads").value, 10),
    threadsBatch: parseInt(document.getElementById("set_threadsBatch").value, 10),
    batchSize: parseInt(document.getElementById("set_batchSize").value, 10),
    ubatchSize: parseInt(document.getElementById("set_ubatchSize").value, 10),
    parallel: parseInt(document.getElementById("set_parallel").value, 10),
    fastStartup: Number(document.getElementById("set_fastStartup").value) === 1 ? "on" : "off",
    flashAttention: Number(document.getElementById("set_flashAttention").value) === 1 ? "on" : "off",
  };
}

settingsBtn.addEventListener("click", () => openSettingsModal());

function closeSettingsModalAndRestoreComposerFocus() {
  settingsModal.classList.add("hidden");
  // Defensive reset: settings apply should never leave composer locked.
  setBusy(false);
  if (promptEl) {
    promptEl.removeAttribute("disabled");
    promptEl.removeAttribute("readonly");
    requestAnimationFrame(() => promptEl.focus());
  }
}

closeSettings.addEventListener("click", () => closeSettingsModalAndRestoreComposerFocus());

applySettings.addEventListener("click", async () => {
  const values = collectSettingsFromUI();
  try {
    if (rawModelJson?.value?.trim()) {
      await window.endocode.setModelRawConfig({ modelId: currentSettingsModelId, rawJson: rawModelJson.value });
    }
    await window.endocode.setModelSettings({ modelId: currentSettingsModelId, settings: values });
    addInlineEvent("note", "Ustawienia", "Zastosowano nowe ustawienia modelu.");
    closeSettingsModalAndRestoreComposerFocus();
    await updateContextInfo(); // refresh indicator with new maxMessages
  } catch (e) {
    addInlineEvent("error", "Ustawienia", e.message || String(e));
  }
});

resetSettings.addEventListener("click", async () => {
  try {
    await window.endocode.resetModelSettings(currentSettingsModelId);
    addInlineEvent("note", "Ustawienia", "Przywrócono rekomendowane ustawienia dla modelu.");
    await openSettingsModal(currentSettingsModelId); // refresh sliders
  } catch (e) {
    addInlineEvent("error", "Ustawienia", e.message || String(e));
  }
});
// ── Tabs Switching ──
const tabLibrary = document.getElementById("tabLibrary");
const tabDiscover = document.getElementById("tabDiscover");
const tabManual = document.getElementById("tabManual");
const tabApi = document.getElementById("tabApi");
const modelsLibraryView = document.getElementById("modelsLibraryView");
const modelsDiscoverView = document.getElementById("modelsDiscoverView");
const modelsManualView = document.getElementById("modelsManualView");
const modelsApiView = document.getElementById("modelsApiView");
const pickManualModelBtn = document.getElementById("pickManualModelBtn");
const manualModelName = document.getElementById("manualModelName");
const manualModelDescription = document.getElementById("manualModelDescription");
const manualImportStatus = document.getElementById("manualImportStatus");

if (tabLibrary && tabDiscover && tabManual && tabApi) {
  const activateTab = (tabName) => {
    tabLibrary.classList.toggle("active", tabName === "library");
    tabDiscover.classList.toggle("active", tabName === "discover");
    tabManual.classList.toggle("active", tabName === "manual");
    tabApi.classList.toggle("active", tabName === "api");
    modelsLibraryView.classList.toggle("hidden", tabName !== "library");
    modelsDiscoverView.classList.toggle("hidden", tabName !== "discover");
    modelsManualView.classList.toggle("hidden", tabName !== "manual");
    modelsApiView.classList.toggle("hidden", tabName !== "api");
    if (tabName === "discover") {
      ensureDiscoveryObserver();
      if (!discoveryAllResults.length && !discoveryLoading) void runDiscoverySearch({ resetResults: true });
    }
    if (tabName === "api") {
      void loadApiProviders();
    }
  };

  tabLibrary.addEventListener("click", () => activateTab("library"));
  tabDiscover.addEventListener("click", () => activateTab("discover"));
  tabManual.addEventListener("click", () => activateTab("manual"));
  tabApi.addEventListener("click", () => activateTab("api"));
}

// ── Discovery Logic ──
const discoveryList = document.getElementById("discoveryList");
const hfSearchInput = document.getElementById("hfSearchInput");
const hfSearchBtn = document.getElementById("hfSearchBtn");
const hfSearchSuggestions = document.getElementById("hfSearchSuggestions");
const discoveryStatus = document.getElementById("discoveryStatus");
const discoverySentinel = document.getElementById("discoverySentinel");
const discoverPills = document.getElementById("discoverPills");
let currentFilter = "all";
let lastDiscoveryResults = new Map();
let discoveryAllResults = [];
let discoveryRenderCount = 0;
let discoveryLoading = false;
let discoveryQueryTimer = null;
let discoveryObserver = null;
let discoveryRequestSeq = 0;
const DISCOVERY_PAGE_SIZE = 18;

function setDiscoveryStatus(text) {
  if (discoveryStatus) discoveryStatus.textContent = text;
}

function setDiscoveryLoading(message = "Ładowanie...") {
  if (!discoveryList) return;
  discoveryList.innerHTML = `<div class="models-loading">${escapeHtml(message)}</div>`;
}

function ensureDiscoveryObserver() {
  if (!discoverySentinel || discoveryObserver) return;
  discoveryObserver = new IntersectionObserver((entries) => {
    const hit = entries.some((entry) => entry.isIntersecting);
    if (!hit) return;
    renderDiscoveryPage(false);
  }, { root: null, threshold: 0.2 });
  discoveryObserver.observe(discoverySentinel);
}

function scheduleDiscoverySearch(delayMs = 220) {
  if (discoveryQueryTimer) clearTimeout(discoveryQueryTimer);
  discoveryQueryTimer = setTimeout(() => {
    discoveryQueryTimer = null;
    void runDiscoverySearch({ resetResults: true });
  }, delayMs);
}

async function runDiscoverySearch(options = {}) {
  const resetResults = options.resetResults !== false;
  const query = hfSearchInput?.value?.trim() || "";
  const requestId = ++discoveryRequestSeq;
  discoveryLoading = true;
  if (resetResults) {
    discoveryAllResults = [];
    discoveryRenderCount = 0;
    setDiscoveryLoading("Pobieram listę modeli z sieci...");
  }
  setDiscoveryStatus("Wyszukiwanie...");
  if (hfSearchBtn) hfSearchBtn.disabled = true;
  try {
    const searchFn = window.endocode.searchModels || window.endocode.searchHfModels;
    const results = await searchFn({ query, filter: currentFilter, source: "huggingface" });
    if (requestId !== discoveryRequestSeq) return;
    discoveryAllResults = Array.isArray(results) ? results : [];
    if (hfSearchSuggestions) {
      const suggestions = discoveryAllResults.map((item) => item.repoId || item.name || item.id).filter(Boolean).slice(0, 20);
      hfSearchSuggestions.innerHTML = suggestions.map((value) => `<option value="${escapeAttr(value)}"></option>`).join("");
    }
    discoveryRenderCount = 0;
    renderDiscoveryPage(true);
    setDiscoveryStatus(`Wyniki: ${discoveryAllResults.length}`);
  } catch (e) {
    if (requestId !== discoveryRequestSeq) return;
    if (discoveryList) discoveryList.innerHTML = `<div class="models-empty error">${escapeHtml(e.message || String(e))}</div>`;
    setDiscoveryStatus("Błąd pobierania");
  } finally {
    if (requestId === discoveryRequestSeq) discoveryLoading = false;
    if (hfSearchBtn) hfSearchBtn.disabled = false;
  }
}

function buildDiscoveryCard(model) {
  const m = model || {};
  const badges = [];
  if (m.recommended) badges.push(`<span class="model-badge recommended">Zalecane dla Twojego PC</span>`);
  if (m.sourceLabel) badges.push(`<span class="model-badge source">${escapeHtml(m.sourceLabel)}</span>`);
  if (m.hardwareProfile && m.recommended) badges.push(`<span class="model-badge fit">${escapeHtml(m.hardwareProfile)}</span>`);
  const fitLabel = m.recommendation?.fitLabel || m.hardwareProfile || (m.recommended ? "Dobre dopasowanie" : "Sprawdź ręcznie");
  const fileLine = m.fileName
    ? `<span class="model-meta-item">Plik: <strong>${escapeHtml(m.fileName)}</strong>${m.expectedBytes ? ` (${escapeHtml((m.expectedBytes / 1024 / 1024 / 1024).toFixed(1))} GB)` : ""}</span>`
    : "";
  const filesBlock = Array.isArray(m.files) && m.files.length
    ? `<div class="discovery-files-list">${m.files.map((file) => `<div class="discovery-file-row"><span class="discovery-file-name" title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</span><button class="model-btn use js-add-discovery-file" data-model-id="${escapeAttr(m.id)}" data-file-name="${escapeAttr(file.name)}">Pobierz</button></div>`).join("")}</div>`
    : "";
  const actions = m.externalOnly
    ? `<button class="model-btn use js-open-model-source" data-url="${escapeAttr(m.openUrl)}">Otwórz stronę</button>`
    : `<button class="model-btn primary js-add-discovery" data-model-id="${escapeAttr(m.id)}" ${m.canDownload ? "" : "disabled"}>Dodaj i pobierz</button>
       ${m.openUrl ? `<button class="model-btn use js-open-model-source" data-url="${escapeAttr(m.openUrl)}">Źródło</button>` : ""}`;

  return `
    <div class="model-item">
      <div class="model-info-header">
        <div class="model-main-info">
          <span class="model-name">${escapeHtml(m.name || m.id || "Model")}</span>
          <span class="model-id">${escapeHtml(m.id || "")}</span>
        </div>
        <div class="model-badges">${badges.join("")}</div>
      </div>
      <div class="model-quick-stats">
        <div class="model-quick-stat"><span>Plik</span><strong>${escapeHtml(m.expectedBytes ? `${(m.expectedBytes / 1024 / 1024 / 1024).toFixed(1)} GB` : "—")}</strong></div>
        <div class="model-quick-stat"><span>Dopasowanie</span><strong>${escapeHtml(fitLabel)}</strong></div>
        <div class="model-quick-stat"><span>Wariantów</span><strong>${escapeHtml(String(Array.isArray(m.files) ? m.files.length : (m.fileName ? 1 : 0)))}</strong></div>
      </div>
      <p class="model-desc">${escapeHtml(m.description || "Brak opisu.")}</p>
      <div class="model-meta">
        <span class="model-meta-item">Autor: ${escapeHtml(m.author || "unknown")}</span>
        ${fileLine}
      </div>
      ${filesBlock}
      <div class="model-actions">${actions}</div>
    </div>
  `;
}

function attachDiscoveryCardHandlers() {
  if (!discoveryList) return;
  discoveryList.querySelectorAll(".js-add-discovery").forEach((btn) => {
    btn.addEventListener("click", () => addAndDownload(btn.getAttribute("data-model-id")));
  });
  discoveryList.querySelectorAll(".js-open-model-source").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await window.endocode.openExternal(btn.getAttribute("data-url"));
      } catch (e) {
        alert(e.message || String(e));
      }
    });
  });
  discoveryList.querySelectorAll(".js-add-discovery-file").forEach((btn) => {
    btn.addEventListener("click", () => addAndDownloadFromFile(
      btn.getAttribute("data-model-id"),
      btn.getAttribute("data-file-name"),
    ));
  });
}

function renderDiscoveryPage(reset = false) {
  if (!discoveryList) return;
  if (reset) {
    discoveryList.innerHTML = "";
    lastDiscoveryResults = new Map();
    discoveryRenderCount = 0;
  }
  if (!discoveryAllResults.length) {
    discoveryList.innerHTML = `<div class="models-empty">Brak wyników dla podanych filtrów.</div>`;
    setDiscoveryStatus("Wyniki: 0");
    return;
  }
  if (discoveryRenderCount >= discoveryAllResults.length) return;
  const next = discoveryAllResults.slice(discoveryRenderCount, discoveryRenderCount + DISCOVERY_PAGE_SIZE);
  const html = next.map((m) => {
    lastDiscoveryResults.set(m.id, m);
    return buildDiscoveryCard(m);
  }).join("");
  discoveryList.insertAdjacentHTML("beforeend", html);
  discoveryRenderCount += next.length;
  attachDiscoveryCardHandlers();
  const loadedAll = discoveryRenderCount >= discoveryAllResults.length;
  setDiscoveryStatus(loadedAll ? `Wyniki: ${discoveryAllResults.length} (koniec listy)` : `Wyniki: ${discoveryRenderCount}/${discoveryAllResults.length}`);
}

if (hfSearchBtn) {
  hfSearchBtn.addEventListener("click", async () => {
    await runDiscoverySearch({ resetResults: true });
  });
}

if (hfSearchInput) {
  hfSearchInput.addEventListener("input", () => {
    scheduleDiscoverySearch(260);
  });
}

if (discoverPills) {
  discoverPills.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-discovery-query]");
    if (!target || !hfSearchInput) return;
    hfSearchInput.value = target.getAttribute("data-discovery-query") || "";
    void runDiscoverySearch({ resetResults: true });
  });
}

document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.getAttribute("data-filter");
    void runDiscoverySearch({ resetResults: true });
  });
});

if (pickManualModelBtn) {
  pickManualModelBtn.addEventListener("click", async () => {
    pickManualModelBtn.disabled = true;
    if (manualImportStatus) manualImportStatus.textContent = "Status: wybierz plik GGUF...";
    try {
      const result = await window.endocode.importLocalModel({
        displayName: manualModelName?.value?.trim() || "",
        description: manualModelDescription?.value?.trim() || "",
      });
      if (result?.canceled) {
        if (manualImportStatus) manualImportStatus.textContent = "Status: anulowano import";
        return;
      }
      if (manualImportStatus) manualImportStatus.textContent = `Status: zaimportowano ${result?.model?.displayName || "model"}`;
      if (manualModelName) manualModelName.value = "";
      if (manualModelDescription) manualModelDescription.value = "";
      await loadModels();
      addInlineEvent("note", "Modele", `Zaimportowano ${result?.model?.displayName || "model"}.`);
      if (tabLibrary) tabLibrary.click();
    } catch (e) {
      if (manualImportStatus) manualImportStatus.textContent = "Status: błąd importu";
      addInlineEvent("error", "Import modelu", e.message || String(e));
    } finally {
      pickManualModelBtn.disabled = false;
    }
  });
}

window.addAndDownload = async (modelKey) => {
  setDiscoveryLoading("Przygotowuję model do pobrania...");
  setDiscoveryStatus("Przygotowuję pobieranie...");
  try {
    const model = lastDiscoveryResults.get(modelKey);
    if (!model || !model.downloadUrl) throw new Error("Ten wynik nie ma bezpośredniego linku do pliku .gguf.");
    const added = await window.endocode.addCustomModel({
      url: model.downloadUrl,
      displayName: model.name,
      description: model.description,
      expectedBytes: model.expectedBytes || 0,
    });
    if (tabLibrary) tabLibrary.click();
    await loadModels();
    setDiscoveryStatus("Uruchamiam pobieranie...");
    if (added?.model?.id) void window.downloadModel(added.model.id);
  } catch (e) {
    alert(e.message);
    await runDiscoverySearch({ resetResults: true });
  }
};

window.addAndDownloadFromFile = async (modelKey, fileName) => {
  setDiscoveryLoading("Przygotowuję wybrany plik do pobrania...");
  setDiscoveryStatus("Przygotowuję pobieranie...");
  try {
    const model = lastDiscoveryResults.get(modelKey);
    const files = Array.isArray(model?.files) ? model.files : [];
    const selected = files.find((file) => file.name === fileName);
    if (!model || !selected) throw new Error("Nie znaleziono wybranego pliku GGUF.");
    const encodedFile = selected.name.split("/").map(encodeURIComponent).join("/");
    const downloadUrl = `https://huggingface.co/${model.repoId}/resolve/main/${encodedFile}`;
    const added = await window.endocode.addCustomModel({
      url: downloadUrl,
      displayName: `${model.name} (${selected.name.split("/").pop()})`,
      description: model.description,
      expectedBytes: selected.sizeBytes || 0,
    });
    if (tabLibrary) tabLibrary.click();
    await loadModels();
    if (added?.model?.id) void window.downloadModel(added.model.id);
  } catch (e) {
    alert(e.message || String(e));
    await runDiscoverySearch({ resetResults: true });
  }
};
