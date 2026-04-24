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
const approvalModal = document.getElementById("approvalModal");
const approvalCwd = document.getElementById("approvalCwd");
const approvalCommand = document.getElementById("approvalCommand");
const approveCommand = document.getElementById("approveCommand");
const rejectCommand = document.getElementById("rejectCommand");
const skillsBtn = document.getElementById("skillsBtn");
const skillsModal = document.getElementById("skillsModal");
const closeSkills = document.getElementById("closeSkills");

// System monitor refs
const cpuBar = document.getElementById("cpuBar");
const cpuValue = document.getElementById("cpuValue");
const gpuBar = document.getElementById("gpuBar");
const gpuValue = document.getElementById("gpuValue");
const ramBar = document.getElementById("ramBar");
const ramValue = document.getElementById("ramValue");

// ── State ──
let pendingApprovalId = null;
let appBusy = false;
let currentThinkingBubble = null;
let currentAccessLevel = "sandbox";
let chatSessions = [];
let activeChatId = null;

// ── Helpers ──
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

// ── Busy State ──
function setBusy(nextBusy) {
  appBusy = nextBusy;
  sendBtn.disabled = nextBusy;
  promptEl.disabled = nextBusy;
  modelSelect.disabled = nextBusy;
  reasoningSelect.disabled = nextBusy;
  if (nextBusy) {
    stopBtn.classList.remove("hidden");
  } else {
    stopBtn.classList.add("hidden");
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

// ── Messages ──
function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text;
  conversation.appendChild(div);
  conversation.scrollTop = conversation.scrollHeight;
  updateWelcome();
}

// ── Inline Events (replaces separate activity panel) ──
function addInlineEvent(kind, title, body = "", extraHtml = "") {
  const iconMap = {
    tool: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 2l8 6-8 6V2z" fill="currentColor"/></svg>`,
    note: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v4M8 11v.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    error: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1l7 13H1L8 1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/></svg>`,
    change: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };

  const div = document.createElement("div");
  div.className = `inline-event ${kind}`;
  div.innerHTML = `
    <span class="inline-event-icon">${iconMap[kind] || iconMap.note}</span>
    <div class="inline-event-body">
      <div class="inline-event-title">${escapeHtml(title)}</div>
      ${body ? `<div class="inline-event-detail">${escapeHtml(body)}</div>` : ""}
      ${extraHtml ? `<div class="inline-event-expand">${extraHtml}</div>` : ""}
    </div>
    <span class="inline-event-time">${new Date().toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}</span>
  `;
  conversation.appendChild(div);
  conversation.scrollTop = conversation.scrollHeight;
  updateWelcome();
}

function toolActionLabel(tool, args) {
  switch (tool) {
    case "read_file": return `Czyta: ${args?.path || ""}`;
    case "write_file": return `Zapisuje: ${args?.path || ""}`;
    case "replace_text": return `Edytuje: ${args?.path || ""}`;
    case "ls": return `Listuje: ${args?.path || "."}`;
    case "cd": return `cd ${args?.path || ""}`;
    case "pwd": return "Sprawdza ścieżkę";
    case "mkdir": return `mkdir ${args?.path || ""}`;
    case "run_powershell": return `Komenda PowerShell`;
    default: return `Narzędzie: ${tool}`;
  }
}

function renderDiff(diff) {
  if (!Array.isArray(diff) || diff.length === 0) return "<pre>Brak zmian.</pre>";
  const rows = diff.map((row) => {
    const prefix = row.type === "add" ? "+ " : row.type === "remove" ? "- " : "  ";
    return `<div class="diff-row ${escapeHtml(row.type)}">${escapeHtml(prefix + (row.text ?? ""))}</div>`;
  }).join("");
  return `<div class="diff">${rows}</div>`;
}

// ── Thinking Bubble ──
function createThinkingBubble() {
  const bubble = document.createElement("div");
  bubble.className = "thinking-bubble";
  bubble.innerHTML = `
    <button class="thinking-toggle" type="button">
      Myślenie modelu <span class="thinking-spinner"></span>
    </button>
    <div class="thinking-content"></div>
  `;
  bubble.querySelector(".thinking-toggle").addEventListener("click", () => {
    bubble.classList.toggle("expanded");
  });
  conversation.appendChild(bubble);
  conversation.scrollTop = conversation.scrollHeight;
  updateWelcome();
  return bubble;
}

function appendThinkingText(bubble, text) {
  const content = bubble.querySelector(".thinking-content");
  if (content) {
    content.textContent += text;
    if (bubble.classList.contains("expanded")) content.scrollTop = content.scrollHeight;
  }
}

function finalizeThinkingBubble(bubble) {
  const spinner = bubble.querySelector(".thinking-spinner");
  if (spinner) spinner.remove();
  const toggle = bubble.querySelector(".thinking-toggle");
  if (toggle) {
    const content = bubble.querySelector(".thinking-content");
    const lines = (content?.textContent || "").split("\n").filter(Boolean).length;
    toggle.innerHTML = `Myślenie modelu · ${lines} linii`;
  }
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
      await window.endocode.deleteChat(session.id);
      await loadChatHistory();
    });
    btn.addEventListener("click", () => switchToChat(session.id));
    chatHistoryList.appendChild(btn);
  }
}

function switchToChat(chatId) {
  // Save current messages title if exists (lightweight approach)
  activeChatId = chatId;
  conversation.innerHTML = "";
  if (welcomeScreen) {
    const ws = document.createElement("div");
    ws.className = "welcome-screen";
    ws.id = "welcomeScreen";
    ws.innerHTML = welcomeScreen.innerHTML;
  }
  const session = chatSessions.find((s) => s.id === chatId);
  if (session) {
    chatTitle.textContent = session.title || "Czat";
    // Replay messages from session
    for (const msg of session.messages || []) {
      addMessage(msg.role, msg.text);
    }
  }
  renderChatHistory();
}

async function startNewChat() {
  await window.endocode.resetChat();
  const newId = generateId();
  activeChatId = newId;
  chatTitle.textContent = "Nowy czat";
  conversation.innerHTML = "";
  // Re-add welcome screen
  const ws = document.createElement("div");
  ws.className = "welcome-screen";
  ws.id = "welcomeScreen";
  ws.innerHTML = `
    <div class="welcome-icon">
      <svg viewBox="0 0 48 48" fill="none" width="56" height="56">
        <defs><linearGradient id="wg2" x1="10" y1="10" x2="38" y2="38"><stop offset="0%" stop-color="#00d4aa"/><stop offset="100%" stop-color="#00b4d8"/></linearGradient></defs>
        <path d="M12 16 L20 24 L12 32" stroke="url(#wg2)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="M24 16 L36 16 M24 24 L34 24 M24 32 L36 32 M24 16 L24 32" stroke="url(#wg2)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </svg>
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
  const title = firstMessage
    ? (firstMessage.length > 50 ? firstMessage.slice(0, 50) + "..." : firstMessage)
    : chatTitle.textContent;

  const msgs = [];
  conversation.querySelectorAll(".message").forEach((el) => {
    msgs.push({
      role: el.classList.contains("user") ? "user" : "assistant",
      text: el.textContent,
    });
  });

  const session = {
    id: activeChatId,
    title,
    createdAt: chatSessions.find((s) => s.id === activeChatId)?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: msgs,
  };

  try {
    chatSessions = await window.endocode.saveChat(session);
    renderChatHistory();
  } catch { /* ignore */ }
}

// ══════════════ SYSTEM MONITOR ══════════════
async function updateSystemMonitor() {
  try {
    const info = await window.endocode.getSystemInfo();
    cpuBar.style.width = `${info.cpu}%`;
    cpuValue.textContent = `${info.cpu}%`;
    if (info.gpu >= 0) {
      gpuBar.style.width = `${info.gpu}%`;
      gpuValue.textContent = `${info.gpu}%`;
    } else {
      gpuBar.style.width = "0%";
      gpuValue.textContent = "N/A";
    }
    ramBar.style.width = `${info.ramPercent}%`;
    ramValue.textContent = `${info.ramUsedGB}G`;
  } catch { /* ignore */ }
}

// ══════════════ CONTEXT INFO ══════════════
async function updateContextInfo() {
  try {
    const info = await window.endocode.getContextInfo();
    contextText.textContent = `${info.messageCount} / ${info.maxMessages} wiadomości`;
    if (info.isNearCompaction) {
      contextIndicator.classList.add("warning");
      contextIndicator.title = "Blisko kompaktowania! Stare wiadomości zostaną usunięte.";
    } else {
      contextIndicator.classList.remove("warning");
      contextIndicator.title = "Kontekst rozmowy";
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
async function refreshState() {
  const state = await window.endocode.getState();
  workspaceLabel.textContent = shortPath(state.workspaceRoot);
  composerWsName.textContent = shortPath(state.workspaceRoot);
  renderModelSelect(state);
  renderReasoningSelect(state);
  updateAccessUI(state.accessLevel || "sandbox");
}

function renderModelSelect(state) {
  modelSelect.innerHTML = "";
  for (const model of state.models || []) {
    const option = document.createElement("option");
    option.value = model.id;
    const progress = model.fileStatus?.expectedBytes ? Math.round((model.fileStatus.progress || 0) * 100) : 0;
    option.textContent = `${model.displayName}${model.available ? "" : ` (${progress}%)`}`;
    option.disabled = !model.available;
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
  await window.endocode.selectWorkspace();
  await refreshState();
});

newChatBtn.addEventListener("click", () => startNewChat());

skillsBtn.addEventListener("click", () => skillsModal.classList.remove("hidden"));
closeSkills.addEventListener("click", () => skillsModal.classList.add("hidden"));

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
  try { await window.endocode.abort(); } catch (e) {
    addInlineEvent("error", "Stop", e.message || String(e));
  }
});

// ── Auto-resize textarea ──
promptEl.addEventListener("input", () => {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(promptEl.scrollHeight, 180) + "px";
});

// ── Submit ──
let firstUserMessage = null;

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = promptEl.value.trim();
  if (!text) return;
  promptEl.value = "";
  promptEl.style.height = "auto";

  if (!firstUserMessage) firstUserMessage = text;
  addMessage("user", text);
  chatTitle.textContent = text.length > 40 ? text.slice(0, 40) + "..." : text;
  setBusy(true);

  try {
    await window.endocode.send(text);
  } catch (e) {
    addInlineEvent("error", "Błąd", e.message || String(e));
  } finally {
    setBusy(false);
    hideLive();
    promptEl.focus();
    await saveChatSession(firstUserMessage);
    await updateContextInfo();
  }
});

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    composer.requestSubmit();
  }
});

// ══════════════ EVENT HANDLER ══════════════
window.endocode.onEvent((event) => {
  if (event.type === "status") {
    if (event.status === "model-thinking") showLive("Myśli...", event.detail || "");
    return;
  }
  if (event.type === "run-start") {
    addInlineEvent("note", "Start", "Rozpoczęto zadanie.");
    showLive("Przygotowuje...");
    return;
  }
  if (event.type === "run-end") {
    hideLive();
    currentThinkingBubble = null;
    updateContextInfo();
    return;
  }
  if (event.type === "note") {
    addInlineEvent("note", "Notatka", event.note);
    showLive("Notatka", event.note);
    return;
  }
  if (event.type === "model-raw") {
    // skip raw JSON in inline view for cleaner UX
    return;
  }
  if (event.type === "thinking-start") {
    currentThinkingBubble = createThinkingBubble();
    showLive("Model myśli...");
    return;
  }
  if (event.type === "thinking-delta") {
    if (currentThinkingBubble) appendThinkingText(currentThinkingBubble, event.text);
    const lastLine = (event.full || "").split("\n").filter(Boolean).pop() || "";
    showLive("Model myśli...", lastLine.slice(0, 120));
    return;
  }
  if (event.type === "thinking-end") {
    if (currentThinkingBubble) {
      finalizeThinkingBubble(currentThinkingBubble);
      currentThinkingBubble = null;
    }
    return;
  }
  if (event.type === "content-delta") {
    showLive("Generuje odpowiedź...");
    return;
  }
  if (event.type === "tool-start") {
    const label = toolActionLabel(event.tool, event.args);
    addInlineEvent("tool", label, event.note || "");
    showLive(label);
    return;
  }
  if (event.type === "tool-result") {
    if (!event.ok) {
      addInlineEvent("error", `Błąd: ${event.tool}`, event.error || "");
    }
    return;
  }
  if (event.type === "file-change") {
    addInlineEvent("change", `${event.action === "write_file" ? "Zapisano" : "Edycja"}: ${event.path}`, "", renderDiff(event.diff));
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
    if (event.note) addInlineEvent("note", "Podsumowanie", event.note);
    addMessage("assistant", event.text);
    hideLive();
    saveChatSession(firstUserMessage);
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
setInterval(() => { if (!appBusy) refreshState(); }, 8000);
setInterval(updateSystemMonitor, 2500);
setInterval(() => { if (appBusy) updateContextInfo(); }, 3000);
