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
const stopBtn = document.getElementById("stopBtn");
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
const liveActivity = document.getElementById("liveActivity");
const liveLabel = document.getElementById("liveLabel");
const liveDetail = document.getElementById("liveDetail");

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
const hfModelUrl = document.getElementById("hfModelUrl");
const addHfModel = document.getElementById("addHfModel");
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
const SHOW_MODEL_THINKING_TRACE = false;
const liveDurationTrackers = new Map();
let liveDurationTicker = null;
let activeRunStartedAtMs = null;
let currentThinkingSegment = null;
const activeToolSegments = [];
let promptQueueItems = [];
let promptQueueSeq = 0;
let promptQueueProcessing = false;
const modelsModule = window.EndoModules?.createModelsModule?.({
  modelsList,
  modelsInstalledList,
  modelsModal,
  modelsStatus,
  modelRenderCacheLibrary,
  modelRenderCacheInstalled,
  escapeHtml,
  escapeAttr,
  api: {
    listModels: () => window.endocode.listModels(),
  },
});

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
  if (nextBusy) {
    stopBtn.classList.remove("hidden");
  } else {
    stopBtn.classList.add("hidden");
    if (promptQueueItems.some((item) => item.status === "queued")) {
      void processPromptQueue();
    }
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
  const currentIdx = promptQueueItems.findIndex((item) => item.id === id && item.status === "queued");
  if (currentIdx < 0) return;
  const targetIdx = direction === "up" ? currentIdx - 1 : currentIdx + 1;
  if (targetIdx < 0 || targetIdx >= promptQueueItems.length) return;
  const target = promptQueueItems[targetIdx];
  if (!target || target.status !== "queued") return;
  const [item] = promptQueueItems.splice(currentIdx, 1);
  promptQueueItems.splice(targetIdx, 0, item);
  renderPromptQueue();
}

function setPromptPriorityNow(id) {
  const idx = promptQueueItems.findIndex((item) => item.id === id && item.status === "queued");
  if (idx < 0) return;
  const firstQueuedIdx = promptQueueItems.findIndex((item) => item.status === "queued");
  if (firstQueuedIdx < 0 || idx === firstQueuedIdx) return;
  const [item] = promptQueueItems.splice(idx, 1);
  promptQueueItems.splice(firstQueuedIdx, 0, item);
  renderPromptQueue();
}

function deletePromptFromQueue(id) {
  const idx = promptQueueItems.findIndex((item) => item.id === id && item.status !== "running");
  if (idx < 0) return;
  promptQueueItems.splice(idx, 1);
  renderPromptQueue();
}

function editPromptInQueue(id) {
  const item = promptQueueItems.find((entry) => entry.id === id && entry.status === "queued");
  if (!item) return;
  const updated = window.prompt("Edytuj prompt:", item.text || "");
  if (updated === null) return;
  const trimmed = String(updated).trim();
  if (!trimmed && !item.attachment) {
    deletePromptFromQueue(id);
    return;
  }
  item.text = trimmed;
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
            ${item.status === "queued" ? `<button data-queue-action="now" data-queue-id="${item.id}" title="Uruchom jako następny">Teraz</button>` : ""}
            ${item.status === "queued" ? `<button data-queue-action="up" data-queue-id="${item.id}" title="Przesuń wyżej">↑</button>` : ""}
            ${item.status === "queued" ? `<button data-queue-action="down" data-queue-id="${item.id}" title="Przesuń niżej">↓</button>` : ""}
            ${item.status === "queued" ? `<button data-queue-action="edit" data-queue-id="${item.id}" title="Edytuj">Edytuj</button>` : ""}
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

// ── Live Activity ──
function showLive(label, detail = "") {
  liveLabel.textContent = label;
  liveDetail.textContent = detail;
  liveActivity.classList.remove("hidden");
}

function hideLive() {
  liveActivity.classList.add("hidden");
  liveDetail.textContent = "";
}

// ── Welcome Screen ──
function updateWelcome() {
  const hasMessages = conversation.querySelectorAll(".message, .inline-event, .thinking-bubble").length > 0;
  if (welcomeScreen) {
    welcomeScreen.style.display = hasMessages ? "none" : "";
  }
}

function smartScroll() {
  const distanceToBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
  if (distanceToBottom < 150) {
    conversation.scrollTop = conversation.scrollHeight;
  }
}

// ── Messages ──
function addMessage(role, text, imageBase64 = null) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.setAttribute("data-raw-text", String(text ?? ""));
  
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
  const jsonFinalMatch = text.match(/"final"\s*:\s*"([\s\S]*?)"/i);
  if (jsonFinalMatch?.[1]) {
    return jsonFinalMatch[1]
      .replace(/\\"/g, "\"")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }
  return "";
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
  if (kind === "error" && options.defaultExpanded !== false) {
    options = { ...options, defaultExpanded: true };
  }

  const variant = options.variant || "";
  const isToolcard = variant === "toolcard";
  const primaryHtml = options.primaryHtml || "";
  const showPrimary = Boolean(primaryHtml) || isToolcard;

  const div = document.createElement("div");
  div.className = `inline-event ${kind}${isToolcard ? " inline-event--toolcard" : ""}`;
  div.setAttribute("data-kind", kind);
  div.setAttribute("data-title", title);
  div.setAttribute("data-body", body);
  div.setAttribute("data-extra-html", extraHtml || "");
  const techOpen = Boolean(options.defaultExpanded);
  div.setAttribute("data-expanded", techOpen ? "true" : "false");
  if (isToolcard) div.setAttribute("data-variant", "toolcard");
  const eventTime = formatClockFromIso(options.eventAt);
  const durationHtml = options.showDuration
    ? `<span class="inline-event-duration">${escapeHtml(options.duration || "00:00")}</span>`
    : "";
  const hasDetail = Boolean(body || extraHtml);
  const detailId = `inline-event-detail-${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)}`;
  const expandLabel = isToolcard && hasDetail ? "Szczegóły techniczne" : "szczegóły";
  const expandToggle = hasDetail ? `<span class="inline-event-expand-toggle">${expandLabel}</span>` : "";
  const primaryBlock = showPrimary
    ? `<div class="inline-event-primary">${primaryHtml || (isToolcard ? "" : "")}</div>`
    : "";
  const detailHiddenClass = techOpen ? "" : " hidden";

  div.innerHTML = `
    <span class="inline-event-icon" aria-hidden="true">${iconMap[kind] || iconMap.note}</span>
    <div class="inline-event-body">
      <button class="inline-event-summary ${hasDetail ? "" : "no-detail"}" type="button" ${hasDetail ? `aria-controls="${detailId}" aria-expanded="${techOpen ? "true" : "false"}"` : "disabled"}>
        <span class="inline-event-title">${escapeHtml(title)}</span>
        ${expandToggle}
      </button>
      ${primaryBlock}
      <div class="inline-event-detail-wrap${detailHiddenClass}" id="${detailId}">
        ${body ? `<div class="inline-event-detail">${escapeHtml(body)}</div>` : ""}
        ${extraHtml ? `<div class="inline-event-expand">${extraHtml}</div>` : ""}
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
      const expanded = !detailWrap.classList.contains("hidden");
      detailWrap.classList.toggle("hidden", expanded);
      div.setAttribute("data-expanded", expanded ? "false" : "true");
      summaryBtn.setAttribute("aria-expanded", expanded ? "false" : "true");
      if (!expanded) {
        requestAnimationFrame(() => {
          detailWrap.scrollTop = 0;
          div.scrollIntoView({ block: "end", behavior: "smooth" });
        });
      } else {
        smartScroll();
      }
    });
  }
  conversation.appendChild(div);
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

async function submitQuickChoicePrompt(text) {
  const prompt = String(text || "").trim();
  if (!prompt) return;
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
const AGENT_PHASE_ACTIVITY_ID = "agent-phase";
const AGENT_NOTE_ACTIVITY_ID = "agent-note";
let lastAgentPhaseSignature = "";

function upsertInlineEvent(activityId, kind, title, body = "") {
  const safeBody = String(body ?? "").slice(0, 50000);
  let el = conversation.querySelector(`.inline-event[data-activity-id="${activityId}"]`);
  if (!el) {
    el = addInlineEvent(kind, title, safeBody);
    el.setAttribute("data-activity-id", activityId);
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
    syncInlineEventPersistAttrs(el);
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

function toolActionDetail(tool, args, note = "") {
  const parts = [];
  if (note) parts.push(note);
  if (tool === "run_powershell" && args?.command) parts.push(args.command);
  else if (tool === "write_file" && args?.path) parts.push(`plik: ${args.path}`);
  else if (tool === "patch_edit" && args?.path) parts.push(`plik: ${args.path}`);
  else if (tool === "patch_batch") parts.push("pakiet blokow SEARCH/REPLACE");
  else if (args && Object.keys(args).length) parts.push(compactJsonPreview(args));
  return parts.join("\n");
}

function toolActionLabel(tool, args) {
  if (tool == null) {
    return "Blad: brak pola tool w odpowiedzi modelu";
  }
  switch (tool) {
    case "read_file": return `Czyta: ${args?.path || ""}`;
    case "write_file": return `Zapisuje: ${args?.path || ""}`;
    case "patch_edit": return `Patch edit: ${args?.path || ""}`;
    case "patch_batch": return "Patch batch: pakiet zmian";
    case "ls": return `Listuje: ${args?.path || "."}`;
    case "cd": return `cd ${args?.path || ""}`;
    case "pwd": return "Sprawdza ścieżkę";
    case "mkdir": return `mkdir ${args?.path || ""}`;
    case "run_powershell": return `Komenda PowerShell`;
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

/** DOM diff block: stats in summary, hunks scrollable (native details, open by default). */
function buildDiffDetailsElement(diff) {
  const details = document.createElement("details");
  details.className = "diff-details";
  details.open = true;
  const summary = document.createElement("summary");
  summary.className = "diff-summary";
  const { hunks, added, removed } = collectDiffHunks(diff);
  if (hunks.length === 0) {
    summary.textContent = "Brak zmian w diffie";
    details.appendChild(summary);
    return details;
  }
  summary.innerHTML = `<span class="diff-stat-plus">+${added}</span> <span class="diff-stat-minus">−${removed}</span><span class="diff-toggle-hint">▸ rozwiń / zwiń</span>`;
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
    primary.appendChild(bucket);
  }
  const block = document.createElement("div");
  block.className = "tool-file-change-block";
  const head = document.createElement("div");
  head.className = "tool-file-change-path";
  head.textContent = String(event.path || "");
  block.appendChild(head);
  block.appendChild(buildDiffDetailsElement(Array.isArray(event.diff) ? event.diff : []));
  bucket.appendChild(block);
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
    if (titleEl) titleEl.textContent = `Odczytano: ${result.path || segment.path || ""}`;
    if (primary) {
      const trunc = result.truncated ? `<div class="file-truncated-hint">Plik skrócony do limitu bajtów (maxBytes).</div>` : "";
      primary.innerHTML = `${trunc}<pre class="file-read-preview">${escapeHtml(String(result.content || ""))}</pre>`;
    }
    if (detailEl) detailEl.textContent = compactJsonPreview(result);
  } else if (tool === "patch_edit" || tool === "write_file" || tool === "patch_batch" || tool === "download_file") {
    const labels = {
      patch_edit: "Zastosowano zmiany",
      write_file: "Zapisano plik",
      patch_batch: "Zastosowano paczkę patchy",
      download_file: "Pobrano plik",
    };
    if (titleEl) {
      if (tool === "patch_batch" && Number.isFinite(Number(result.appliedCount))) {
        titleEl.textContent = `${labels.patch_batch} · ${result.appliedCount} plik(ów)`;
      } else {
        const pathHint = result.path || (Array.isArray(result.applied) && result.applied[0]?.path) || segment.path || "";
        titleEl.textContent = `${labels[tool] || "Gotowe"}: ${pathHint}`;
      }
    }
    if (primary && !primary.querySelector(".tool-file-changes") && !primary.querySelector(".file-read-preview")) {
      primary.innerHTML = `<div class="tool-run-note">Zakończono (brak wizualnego diff w tej karcie).</div>`;
    }
    if (detailEl) detailEl.textContent = compactJsonPreview(result);
  } else {
    if (titleEl) titleEl.textContent = `Gotowe: ${tool}`;
    if (primary) {
      const snippet = compactJsonPreview(result).slice(0, 12000);
      primary.innerHTML = `<pre class="tool-result-snippet">${escapeHtml(snippet)}</pre>`;
    }
    if (detailEl) detailEl.textContent = compactJsonPreview(result);
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
    primary.innerHTML = `<pre class="tool-error-body">${escapeHtml(msg)}</pre>`;
  }
  const detailWrap = el.querySelector(".inline-event-detail-wrap");
  if (detailWrap) {
    detailWrap.classList.remove("hidden");
    const summaryBtn = el.querySelector(".inline-event-summary");
    if (summaryBtn) summaryBtn.setAttribute("aria-expanded", "true");
    el.setAttribute("data-expanded", "true");
  }
  const detailEl = el.querySelector(".inline-event-detail");
  if (detailEl) detailEl.textContent = compactJsonPreview({ tool: event.tool, error: event.error, recoveryHint: event.recoveryHint });
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
function createThinkingBubble(step = null) {
  const stepLabel = step ? `Krok ${step}: ` : "";
  const bubble = document.createElement("div");
  bubble.className = "thinking-bubble";
  bubble.innerHTML = `
    <button class="thinking-toggle" type="button">
      ${stepLabel}Myślenie modelu <span class="thinking-duration">00:00</span> <span class="thinking-spinner"></span>
    </button>
    <div class="thinking-content"></div>
  `;
  bubble.classList.add("expanded");

  bubble.querySelector(".thinking-toggle").addEventListener("click", () => {
    bubble.classList.toggle("expanded");
  });
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
        addInlineEvent(entry.kind, entry.title, entry.body || "", entry.extraHtml || "", {
          variant: entry.variant || "",
          primaryHtml: entry.primaryHtml || "",
          defaultExpanded: entry.techExpanded === true,
        });
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
  if (!activeChatId) activeChatId = generateId();
  let state = null;
  try { state = await window.endocode.getState(); } catch { /* ignore */ }
  const title = firstMessage
    ? (firstMessage.length > 50 ? firstMessage.slice(0, 50) + "..." : firstMessage)
    : chatTitle.textContent;

  // Capture ALL conversation entries (messages + inline events)
  const entries = [];
  conversation.querySelectorAll(".message, .inline-event").forEach((el) => {
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
      const techExpanded = Boolean(techWrap && !techWrap.classList.contains("hidden"));
      const variant = el.getAttribute("data-variant") || "";
      const payload = {
        type: "event",
        kind: el.getAttribute("data-kind") || "note",
        title: el.querySelector(".inline-event-title")?.textContent || el.getAttribute("data-title") || "",
        body: el.querySelector(".inline-event-detail")?.textContent ?? el.getAttribute("data-body") ?? "",
        extraHtml: extraFromDom,
      };
      if (primaryHtml) payload.primaryHtml = primaryHtml;
      if (techExpanded) payload.techExpanded = true;
      if (variant) payload.variant = variant;
      entries.push(payload);
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
        circle.style.stroke = "#ef4444";
      } else if (percent > 0.6) {
        circle.style.stroke = "#f59e0b";
      } else {
        circle.style.stroke = "currentColor";
      }
    }

    if (info.isNearCompaction) {
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

  if (availableModels.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Brak pobranych modeli";
    option.disabled = true;
    option.selected = true;
    modelSelect.appendChild(option);
    modelSelect.disabled = true;
    return;
  }

  modelSelect.disabled = false;
  for (const model of availableModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.displayName;
    option.disabled = false;
    option.selected = model.id === state.selectedModelId;
    modelSelect.appendChild(option);
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
    modelsModule?.setModelsStatus?.("Rozpoczynam pobieranie...");
    await window.endocode.downloadModel(modelId);
    await loadModels();
  } catch (e) {
    alert(`Błąd pobierania: ${e.message}`);
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

// ══════════════ APPROVAL MODAL ══════════════
function openApproval(request, approvalId) {
  pendingApprovalId = approvalId;
  approvalCwd.textContent = `cwd: ${request.cwd}`;
  approvalCommand.textContent = request.command;
  approvalModal.classList.remove("hidden");
}

function closeApproval(approved) {
  if (pendingApprovalId) window.endocode.approve(pendingApprovalId, approved);
  pendingApprovalId = null;
  approvalModal.classList.add("hidden");
}

// ══════════════ EVENT LISTENERS ══════════════
approveCommand.addEventListener("click", () => closeApproval(true));
rejectCommand.addEventListener("click", () => closeApproval(false));

chooseWorkspaceBtn.addEventListener("click", async () => {
  const state = await window.endocode.selectWorkspace();
  applyStateToUi(state);
  await saveChatSession(firstUserMessage);
});

newChatBtn.addEventListener("click", () => startNewChat());

modelsBtn.addEventListener("click", async () => {
  modelsModal.classList.remove("hidden");
  await loadModels();
});
closeModels.addEventListener("click", () => modelsModal.classList.add("hidden"));

if (addHfModel) {
  addHfModel.addEventListener("click", async () => {
    const url = hfModelUrl.value.trim();
    if (!url) return;
    addHfModel.disabled = true;
    try {
      await window.endocode.addCustomModel(url);
      hfModelUrl.value = "";
      await loadModels();
      addInlineEvent("note", "Katalog", "Dodano własny model do listy.");
    } catch (e) {
      alert(e.message);
    } finally {
      addHfModel.disabled = false;
    }
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
    await startNewChat();
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

stopBtn.addEventListener("click", async () => {
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
    else if (action === "now") setPromptPriorityNow(id);
  });
}

conversation.addEventListener("click", (event) => {
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

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = promptEl.value.trim();
  if (!text && !currentAttachmentFile) return;
  promptEl.value = "";
  promptEl.style.height = "auto";

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
      addInlineEvent("note", "Runtime modelu", event.detail || "Ponawiam po błędzie modelu.");
      showLive("Restart modelu...", event.detail || "");
    } else if (event.status === "model-action-ready") {
      showLive("Akcja gotowa", event.detail || "");
    } else if (event.status === "model-fallback") {
      addInlineEvent("note", "Fallback modelu", event.detail || "Przełączam model.");
      showLive("Fallback modelu...", event.detail || "");
      refreshState();
    } else if (event.status === "model-fallback-failed") {
      addInlineEvent("error", "Fallback modelu", event.detail || "Model zapasowy nie wystartował.");
    } else if (event.status === "context-compacted") {
      addInlineEvent("note", "Kontekst", event.detail || "Skompaktowano kontekst rozmowy.");
      showLive("Kontekst", event.detail || "");
      updateContextInfo();
    } else if (event.status === "downloading") {
      showLive("Pobieranie", event.detail || "");
    } else if (event.status === "runtime-install") {
      showLive("Instalacja runtime", event.detail || "");
    } else if (event.status === "runtime-install-complete") {
      addInlineEvent("note", "Runtime", event.detail || "Runtime llama.cpp zainstalowany.");
      showLive("Instalacja runtime", event.detail || "");
    } else if (event.status === "server-killing") showLive("Kill switch...", event.detail || "");
    else if (event.status === "server-killed") showLive("Kill switch", event.detail || "");
    else if (event.status === "server-starting" || event.status === "server-stopping") showLive("Runtime modelu", event.detail || "");
    else if (event.status === "download-complete") {
      addInlineEvent("note", "Pobieranie", event.detail || "Model pobrany pomyślnie.");
      loadModels();
    }
    return;
  }
  if (event.type === "chat-web-lookup") {
    const phase = String(event.phase || "");
    if (phase === "start") {
      showLive("Web lookup", "Wyszukiwanie i lekka ekstrakcja danych...");
      const startDetail = `${event.detail || "Rozpoczynam wyszukiwanie."}${event.lookupQuery ? `\nZapytanie modelu: ${event.lookupQuery}` : ""}`;
      addInlineEvent("activity", "Web lookup", startDetail);
      return;
    }
    if (phase === "error") {
      showLive("Web lookup: błąd", event.detail || "Błąd pobierania kontekstu internetowego.");
      addInlineEvent("error", "Web lookup", event.detail || "Błąd pobierania kontekstu internetowego.");
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
      addInlineEvent("activity", "Web lookup", detail || "Brak wyników web lookup.");
      return;
    }
  }
  if (event.type === "model-download-progress") {
    if (modelsModal?.classList?.contains("hidden")) return;
    if (modelsStatus) {
      const downloadedMb = (event.downloaded / 1024 / 1024).toFixed(0);
      const totalMb = event.total > 0 ? ` / ${(event.total / 1024 / 1024).toFixed(0)} MB` : "";
      const progress = event.total > 0 ? `${event.progress}%` : `${downloadedMb} MB`;
      modelsStatus.textContent = `Pobieranie ${event.modelId}: ${progress} (${downloadedMb} MB${totalMb})`;
    }
    patchModelDownloadProgress(event.modelId, event.progress, event.downloaded, event.total);
    return;
  }
  if (event.type === "model-download-state") {
    if (event.state === "failed" && modelsStatus) {
      modelsStatus.textContent = `Błąd pobierania ${event.modelId}: ${event.error || "nieznany błąd"}`;
    } else if (event.state === "completed" && modelsStatus) {
      modelsStatus.textContent = `Pobrano model ${event.modelId}.`;
    }
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
    activeRunStartedAtMs = parseEventTimeMs(event);
    stopAllLiveDurations();
    currentThinkingSegment = null;
    activeToolSegments.length = 0;
    lastAgentPhaseSignature = "";
    removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
    removeInlineEventByActivityId(AGENT_PHASE_ACTIVITY_ID);
    removeInlineEventByActivityId(AGENT_NOTE_ACTIVITY_ID);
    const rawInput = String(event.text || "").trim();
    const shortInput = rawInput.length > 240 ? `${rawInput.slice(0, 240)}...` : rawInput;
    const planningDetail = shortInput
      ? `Start tury. Wejście użytkownika: ${shortInput}`
      : "Start tury. Brak tekstu wejściowego (np. załącznik lub akcja systemowa).";
    addInlineEvent("activity", "Model planuje", planningDetail);
    showLive("Planowanie...", shortInput || "Przygotowanie kontekstu i kolejnych kroków.");
    return;
  }
  if (event.type === "run-end") {
    stopAllLiveDurations();
    activeToolSegments.length = 0;
    currentThinkingSegment = null;
    lastAgentPhaseSignature = "";
    removeInlineEventByActivityId(AGENT_PHASE_ACTIVITY_ID);
    removeInlineEventByActivityId(AGENT_NOTE_ACTIVITY_ID);
    if (hasStreamingAssistantContent()) {
      finalizeStreamingAssistantMessage("", { overwriteText: false });
    }
    setBusy(false);
    hideLive();
    currentThinkingBubble = null;
    updateContextInfo();
    return;
  }
  if (event.type === "note") {
    removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
    upsertInlineEvent(AGENT_NOTE_ACTIVITY_ID, "activity", "Model planuje", event.note);
    showLive("Notatka", event.note);
    return;
  }
  if (event.type === "agent-phase") {
    const phase = String(event.phase || "");
    const phaseLabel =
      phase === "understand" ? "Analiza intencji"
        : phase === "plan" ? "Planowanie"
          : phase === "validate" ? "Walidacja"
            : phase === "execute" ? "Wykonanie"
              : phase === "observe" ? "Obserwacja"
                : phase === "recover" ? "Recovery"
                  : phase === "finalize" ? "Finalizacja"
                    : "Agent";
    const detail = [
      event.intentClass ? `intent=${event.intentClass}` : "",
      event.tool ? `tool=${event.tool}` : "",
      event.reason ? `reason=${event.reason}` : "",
      event.step ? `step=${event.step}` : "",
    ].filter(Boolean).join(" · ");
    const signature = `${phase}|${detail}`;
    if (signature !== lastAgentPhaseSignature) {
      lastAgentPhaseSignature = signature;
      upsertInlineEvent(AGENT_PHASE_ACTIVITY_ID, "activity", `Model planuje: ${phaseLabel}`, detail || "Przetwarzanie etapu.");
      showLive(`Etap: ${phaseLabel}`, detail || "Przetwarzanie");
    }
    return;
  }
  if (event.type === "model-raw") {
    // skip raw JSON in inline view for cleaner UX
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
    
    const writingLabel = event.plainChat ? "Odpowiedź" : "Model wybiera akcję";
    const livePhrase = event.plainChat ? "Pisze…" : "Planuje akcję...";

    if (event.plainChat) {
      removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
      updateStreamingAssistantMessage(event.text || "", full);
    } else if (preview) {
      upsertInlineEvent(MODEL_WRITING_ACTIVITY_ID, "activity", writingLabel, preview);
      const liveFinal = extractLiveAnswerFromDelta(full);
      if (liveFinal) {
        removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
        updateStreamingAssistantMessage("", liveFinal);
      }
    }
    showLive(livePhrase, preview.slice(-500));
    return;
  }

  if (event.type === "tool-start") {
    removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
    const label = toolActionLabel(event.tool, event.args);
    const detail = toolActionDetail(event.tool, event.args, event.note || "");
    const path = toolSegmentPath(event.tool, event.args);
    const primaryHtml = `<div class="tool-run-placeholder"><span class="tool-run-badge">W toku</span><span class="tool-run-path">${escapeHtml(shortPath(path) || path || "—")}</span></div>`;
    const toolEvent = addInlineEvent("tool", label, detail, "", {
      eventAt: event.at,
      showDuration: true,
      duration: "00:00",
      variant: "toolcard",
      primaryHtml,
    });
    const durationEl = toolEvent.querySelector(".inline-event-duration");
    const durationKey = `tool-${event.tool || "unknown"}-${event.id || Date.now()}`;
    if (durationEl) startLiveDuration(durationKey, parseEventTimeMs(event), durationEl);
    activeToolSegments.push({ key: durationKey, tool: event.tool, el: toolEvent, path });
    showLive(label, detail);
    return;
  }
  if (event.type === "tool-result") {
    const matchingIndex = activeToolSegments.findIndex((segment) => segment.tool === event.tool);
    const segment = matchingIndex >= 0 ? activeToolSegments.splice(matchingIndex, 1)[0] : activeToolSegments.shift();
    if (segment?.key) stopLiveDuration(segment.key, parseEventTimeMs(event));
    const durationText = segment?.el?.querySelector(".inline-event-duration")?.textContent || "00:00";
    if (!event.ok) {
      if (!finalizeToolCardError(segment, event)) {
        const errorEl = addInlineEvent("error", `Błąd: ${event.tool}`, `${event.error || ""}${event.recoveryHint ? `\nObejście: ${event.recoveryHint}` : ""}`, "", { eventAt: event.at });
        setInlineEventDuration(errorEl, durationText);
      } else if (segment?.el) {
        setInlineEventDuration(segment.el, durationText);
      }
    } else if (!finalizeToolCardSuccess(segment, event)) {
      const okEl = addInlineEvent("activity", `Zakończono: ${event.tool}`, compactJsonPreview(event.result || {}), "", { eventAt: event.at });
      setInlineEventDuration(okEl, durationText);
    } else if (segment?.el) {
      setInlineEventDuration(segment.el, durationText);
    }
    return;
  }
  if (event.type === "file-change") {
    const seg = findSegmentForFileChange(event);
    if (seg) {
      mergeFileChangeIntoToolCard(seg, event);
      showLive(`Zapisano: ${event.path}`);
      return;
    }
    const actionLabel =
      event.action === "write_file"
        ? "Zapisano"
        : event.action === "patch_edit"
          ? "Zastosowano patch"
          : event.action === "download_file"
            ? "Pobrano"
            : "Edycja";
    const body = "";
    addInlineEvent("change", `${actionLabel}: ${event.path}`, body, renderDiff(event.diff));
    showLive(`Zapisano: ${event.path}`);
    return;
  }
  if (event.type === "approval-request") {
    addInlineEvent("tool", "Prośba o komendę", `${event.request.cwd}: ${event.request.command}`);
    openApproval(event.request, event.approvalId);
    showLive("Czeka na zatwierdzenie...");
    return;
  }
  if (event.type === "final") {
    removeInlineEventByActivityId(MODEL_WRITING_ACTIVITY_ID);
    if (event.note) addInlineEvent("note", "Podsumowanie", event.note);
    if (hasStreamingAssistantContent()) {
      finalizeStreamingAssistantMessage(event.text || "");
    } else if (String(event.text || "").trim()) {
      addMessage("assistant", event.text);
    }
    const sources = extractSourcesFromAnswer(event.text || "");
    if (sources.length) {
      addInlineEvent("activity", "Źródła", sources.map((url) => `- ${url}`).join("\n"));
    }
    if (Number.isFinite(activeRunStartedAtMs)) {
      addTotalDurationDivider(parseEventTimeMs(event) - activeRunStartedAtMs);
      activeRunStartedAtMs = null;
    }
    hideLive();
    saveChatSession(firstUserMessage);
  }
  if (event.type === "quick-choices") {
    addInlineEvent("activity", "Wybór kolejnego kroku", "", buildQuickChoicesHtml(event), { eventAt: event.at });
    return;
  }
});

// ══════════════ INIT ══════════════
async function init() {
  await refreshState();
  await loadChatHistory();
  await updateSystemMonitor();
  await updateContextInfo();
  activeChatId = generateId();
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
  { id: "gpuLayers", slider: "set_gpuLayers", display: "val_gpuLayers", decimals: 0 },
  { id: "maxMessages", slider: "set_maxMessages", display: "val_maxMessages", decimals: 0 },
  { id: "threads", slider: "set_threads", display: "val_threads", decimals: 0 },
  { id: "threadsBatch", slider: "set_threadsBatch", display: "val_threadsBatch", decimals: 0 },
  { id: "batchSize", slider: "set_batchSize", display: "val_batchSize", decimals: 0 },
  { id: "ubatchSize", slider: "set_ubatchSize", display: "val_ubatchSize", decimals: 0 },
  { id: "parallel", slider: "set_parallel", display: "val_parallel", decimals: 0 },
  { id: "flashAttention", slider: "set_flashAttention", display: "val_flashAttention", decimals: 0, formatFn: (v) => Number(v) === 1 ? "on" : "off" },
];
const BASIC_SETTINGS = new Set(["contextTokens", "gpuLayers", "maxTokens", "maxMessages"]);
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
  setSlider("set_gpuLayers", "val_gpuLayers", settings.gpuLayers ?? eff.gpuLayers, 0);
  setSlider("set_maxMessages", "val_maxMessages", settings.maxMessages ?? eff.maxMessages ?? 32, 0);
  setSlider("set_threads", "val_threads", settings.threads ?? eff.threads ?? 8, 0);
  setSlider("set_threadsBatch", "val_threadsBatch", settings.threadsBatch ?? eff.threadsBatch ?? 12, 0);
  setSlider("set_batchSize", "val_batchSize", settings.batchSize ?? eff.batchSize ?? 1024, 0);
  setSlider("set_ubatchSize", "val_ubatchSize", settings.ubatchSize ?? eff.ubatchSize ?? 512, 0);
  setSlider("set_parallel", "val_parallel", settings.parallel ?? eff.parallel ?? 1, 0);
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
    gpuLayers: parseInt(document.getElementById("set_gpuLayers").value, 10),
    maxMessages: parseInt(document.getElementById("set_maxMessages").value, 10),
    threads: parseInt(document.getElementById("set_threads").value, 10),
    threadsBatch: parseInt(document.getElementById("set_threadsBatch").value, 10),
    batchSize: parseInt(document.getElementById("set_batchSize").value, 10),
    ubatchSize: parseInt(document.getElementById("set_ubatchSize").value, 10),
    parallel: parseInt(document.getElementById("set_parallel").value, 10),
    flashAttention: Number(document.getElementById("set_flashAttention").value) === 1 ? "on" : "off",
  };
}

settingsBtn.addEventListener("click", () => openSettingsModal());
closeSettings.addEventListener("click", () => settingsModal.classList.add("hidden"));

applySettings.addEventListener("click", async () => {
  const values = collectSettingsFromUI();
  try {
    if (rawModelJson?.value?.trim()) {
      await window.endocode.setModelRawConfig({ modelId: currentSettingsModelId, rawJson: rawModelJson.value });
    }
    await window.endocode.setModelSettings({ modelId: currentSettingsModelId, settings: values });
    addInlineEvent("note", "Ustawienia", "Zastosowano nowe ustawienia modelu.");
    settingsModal.classList.add("hidden");
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
const tabInstalled = document.getElementById("tabInstalled");
const tabDiscover = document.getElementById("tabDiscover");
const tabManual = document.getElementById("tabManual");
const modelsLibraryView = document.getElementById("modelsLibraryView");
const modelsInstalledView = document.getElementById("modelsInstalledView");
const modelsDiscoverView = document.getElementById("modelsDiscoverView");
const modelsManualView = document.getElementById("modelsManualView");
const pickManualModelBtn = document.getElementById("pickManualModelBtn");
const manualModelName = document.getElementById("manualModelName");
const manualModelDescription = document.getElementById("manualModelDescription");
const manualImportStatus = document.getElementById("manualImportStatus");

if (tabLibrary && tabDiscover && tabInstalled && tabManual) {
  const activateTab = (tabName) => {
    tabLibrary.classList.toggle("active", tabName === "library");
    tabInstalled.classList.toggle("active", tabName === "installed");
    tabDiscover.classList.toggle("active", tabName === "discover");
    tabManual.classList.toggle("active", tabName === "manual");
    modelsLibraryView.classList.toggle("hidden", tabName !== "library");
    modelsInstalledView.classList.toggle("hidden", tabName !== "installed");
    modelsDiscoverView.classList.toggle("hidden", tabName !== "discover");
    modelsManualView.classList.toggle("hidden", tabName !== "manual");
    if (tabName === "discover") {
      ensureDiscoveryObserver();
      if (!discoveryAllResults.length && !discoveryLoading) void runDiscoverySearch({ resetResults: true });
    }
  };

  tabLibrary.addEventListener("click", () => activateTab("library"));
  tabInstalled.addEventListener("click", () => activateTab("installed"));
  tabDiscover.addEventListener("click", () => activateTab("discover"));
  tabManual.addEventListener("click", () => activateTab("manual"));
}

// ── Discovery Logic ──
const discoveryList = document.getElementById("discoveryList");
const hfSearchInput = document.getElementById("hfSearchInput");
const hfSearchBtn = document.getElementById("hfSearchBtn");
const modelSourceSelect = document.getElementById("modelSourceSelect");
const discoveryStatus = document.getElementById("discoveryStatus");
const discoverySentinel = document.getElementById("discoverySentinel");
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
  const source = modelSourceSelect?.value || "all";
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
    const results = await searchFn({ query, filter: currentFilter, source });
    if (requestId !== discoveryRequestSeq) return;
    discoveryAllResults = Array.isArray(results) ? results : [];
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
  const fileLine = m.fileName
    ? `<span class="model-meta-item">Plik: <strong>${escapeHtml(m.fileName)}</strong>${m.expectedBytes ? ` (${escapeHtml((m.expectedBytes / 1024 / 1024 / 1024).toFixed(1))} GB)` : ""}</span>`
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
      <p class="model-desc">${escapeHtml(m.description || "Brak opisu.")}</p>
      <div class="model-meta">
        <span class="model-meta-item">Autor: ${escapeHtml(m.author || "unknown")}</span>
        ${fileLine}
      </div>
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

document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.getAttribute("data-filter");
    void runDiscoverySearch({ resetResults: true });
  });
});

if (modelSourceSelect) {
  modelSourceSelect.addEventListener("change", () => {
    void runDiscoverySearch({ resetResults: true });
  });
}

if (pickManualModelBtn) {
  pickManualModelBtn.addEventListener("click", async () => {
    pickManualModelBtn.disabled = true;
    if (manualImportStatus) manualImportStatus.textContent = "Status: wybieranie pliku...";
    try {
      const result = await window.endocode.importLocalModel({
        displayName: manualModelName?.value?.trim() || "",
        description: manualModelDescription?.value?.trim() || "",
      });
      if (result?.canceled) {
        if (manualImportStatus) manualImportStatus.textContent = "Status: anulowano";
        return;
      }
      if (manualImportStatus) manualImportStatus.textContent = "Status: zaimportowano model";
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
    if (added?.model?.id) window.endocode.downloadModel(added.model.id);
  } catch (e) {
    alert(e.message);
    await runDiscoverySearch({ resetResults: true });
  }
};
