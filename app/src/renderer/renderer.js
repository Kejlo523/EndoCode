const conversation = document.getElementById("conversation");
const timeline = document.getElementById("timeline");
const statusEl = document.getElementById("status");
const statusKicker = document.getElementById("statusKicker");
const workspaceLabel = document.getElementById("workspaceLabel");
const activeModelName = document.getElementById("activeModelName");
const activeModelMeta = document.getElementById("activeModelMeta");
const eventCount = document.getElementById("eventCount");
const composer = document.getElementById("composer");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stopBtn");
const chooseWorkspaceBtn = document.getElementById("chooseWorkspace");
const resetChatBtn = document.getElementById("resetChat");
const modelSelect = document.getElementById("modelSelect");
const reasoningSelect = document.getElementById("reasoningSelect");
const approvalModal = document.getElementById("approvalModal");
const approvalCwd = document.getElementById("approvalCwd");
const approvalCommand = document.getElementById("approvalCommand");
const approveCommand = document.getElementById("approveCommand");
const rejectCommand = document.getElementById("rejectCommand");
const liveActivity = document.getElementById("liveActivity");
const liveLabel = document.getElementById("liveLabel");
const liveDetail = document.getElementById("liveDetail");

let pendingApprovalId = null;
let visibleEvents = 0;
let appBusy = false;
let currentThinkingBubble = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

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

function showLive(label, detail = "") {
  liveLabel.textContent = label;
  liveDetail.textContent = detail;
  liveActivity.classList.remove("hidden");
}

function hideLive() {
  liveActivity.classList.add("hidden");
  liveDetail.textContent = "";
}

// ── Tool label mapping for activity indicator ──
function toolActionLabel(tool, args) {
  switch (tool) {
    case "read_file":
      return `Czyta plik: ${args?.path || ""}`;
    case "write_file":
      return `Zapisuje plik: ${args?.path || ""}`;
    case "replace_text":
      return `Edytuje plik: ${args?.path || ""}`;
    case "ls":
      return `Listuje: ${args?.path || "."}`;
    case "cd":
      return `Zmienia katalog: ${args?.path || ""}`;
    case "pwd":
      return "Sprawdza ścieżkę";
    case "mkdir":
      return `Tworzy folder: ${args?.path || ""}`;
    case "run_powershell":
      return `Uruchamia komendę`;
    default:
      return `Narzędzie: ${tool}`;
  }
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text;
  conversation.appendChild(div);
  conversation.scrollTop = conversation.scrollHeight;
}

function addEvent(kind, title, body, extraHtml = "") {
  visibleEvents += 1;
  eventCount.textContent = String(visibleEvents);
  const div = document.createElement("div");
  div.className = `event ${kind}`;
  div.innerHTML = `
    <div class="event-head">
      <span class="event-title">${escapeHtml(title)}</span>
      <span>${new Date().toLocaleTimeString()}</span>
    </div>
    ${body ? `<div>${escapeHtml(body)}</div>` : ""}
    ${extraHtml}
  `;
  timeline.prepend(div);
}

function renderJson(value) {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function renderDiff(diff) {
  if (!Array.isArray(diff) || diff.length === 0) return "<pre>Brak zmian w treści.</pre>";
  const rows = diff.map((row) => {
    const prefix = row.type === "add" ? "+ " : row.type === "remove" ? "- " : "  ";
    return `<div class="diff-row ${escapeHtml(row.type)}">${escapeHtml(prefix + (row.text ?? ""))}</div>`;
  }).join("");
  return `<div class="diff">${rows}</div>`;
}

// ── Thinking bubble management ──
function createThinkingBubble() {
  const bubble = document.createElement("div");
  bubble.className = "thinking-bubble";
  bubble.innerHTML = `
    <button class="thinking-toggle" type="button">
      Myślenie modelu <span class="thinking-spinner"></span>
    </button>
    <div class="thinking-content"></div>
  `;
  const toggle = bubble.querySelector(".thinking-toggle");
  toggle.addEventListener("click", () => {
    bubble.classList.toggle("expanded");
  });
  conversation.appendChild(bubble);
  conversation.scrollTop = conversation.scrollHeight;
  return bubble;
}

function appendThinkingText(bubble, text) {
  const content = bubble.querySelector(".thinking-content");
  if (content) {
    content.textContent += text;
    if (bubble.classList.contains("expanded")) {
      content.scrollTop = content.scrollHeight;
    }
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

async function refreshState() {
  const state = await window.bielik.getState();
  workspaceLabel.textContent = state.workspaceRoot;
  renderModelMeta(state);
  renderModelSelect(state);
  renderReasoningSelect(state);
}

function renderModelMeta(state) {
  const model = state.modelConfig || {};
  const selected = (state.models || []).find((item) => item.id === state.selectedModelId) || model;
  activeModelName.textContent = model.displayName || model.id || "...";
  const fileState = selected.available ? "gotowy" : "brak pliku";
  const progress = selected.fileStatus?.expectedBytes ? `${Math.round((selected.fileStatus.progress || 0) * 100)}%` : fileState;
  const ctx = model.contextTokens ? `${model.contextTokens} ctx` : "ctx auto";
  const gpu = model.gpuLayers !== undefined ? `${model.gpuLayers} GPU layers` : "GPU auto";
  activeModelMeta.textContent = `${selected.available ? "gotowy" : progress} · ${ctx} · ${gpu}`;
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

function openApproval(request, approvalId) {
  pendingApprovalId = approvalId;
  approvalCwd.textContent = `cwd: ${request.cwd}`;
  approvalCommand.textContent = request.command;
  approvalModal.classList.remove("hidden");
}

function closeApproval(approved) {
  if (pendingApprovalId) {
    window.bielik.approve(pendingApprovalId, approved);
  }
  pendingApprovalId = null;
  approvalModal.classList.add("hidden");
}

approveCommand.addEventListener("click", () => closeApproval(true));
rejectCommand.addEventListener("click", () => closeApproval(false));

chooseWorkspaceBtn.addEventListener("click", async () => {
  await window.bielik.selectWorkspace();
  await refreshState();
});

resetChatBtn.addEventListener("click", async () => {
  await window.bielik.resetChat();
  conversation.innerHTML = "";
  timeline.innerHTML = "";
  visibleEvents = 0;
  eventCount.textContent = "0";
  currentThinkingBubble = null;
  addEvent("note", "Kontekst", "Wyczyszczono rozmowę.");
});

modelSelect.addEventListener("change", async () => {
  setBusy(true);
  try {
    const state = await window.bielik.setModel(modelSelect.value);
    renderModelSelect(state);
    renderReasoningSelect(state);
    renderModelMeta(state);
    workspaceLabel.textContent = state.workspaceRoot;
    conversation.innerHTML = "";
    timeline.innerHTML = "";
    visibleEvents = 0;
    eventCount.textContent = "0";
    currentThinkingBubble = null;
    addEvent("note", "Model", `Wybrano ${state.modelConfig.displayName}.`);
  } catch (error) {
    addEvent("error", "Model", error.message || String(error));
    await refreshState();
  } finally {
    setBusy(false);
  }
});

reasoningSelect.addEventListener("change", async () => {
  try {
    const state = await window.bielik.setReasoning(reasoningSelect.value);
    renderReasoningSelect(state);
    addEvent("note", "Tryb pracy", `Ustawiono ${state.reasoningLevels[state.selectedReasoning].label}.`);
  } catch (error) {
    addEvent("error", "Tryb pracy", error.message || String(error));
    await refreshState();
  }
});

// ── Stop button ──
stopBtn.addEventListener("click", async () => {
  try {
    await window.bielik.abort();
  } catch (error) {
    addEvent("error", "Stop", error.message || String(error));
  }
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = promptEl.value.trim();
  if (!text) return;
  promptEl.value = "";
  addMessage("user", text);
  setBusy(true);
  try {
    await window.bielik.send(text);
  } catch (error) {
    addEvent("error", "Błąd", error.message || String(error));
  } finally {
    setBusy(false);
    hideLive();
    promptEl.focus();
  }
});

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    composer.requestSubmit();
  }
});

// ── Event handler ──
window.bielik.onEvent((event) => {
  if (event.type === "status") {
    const value = event.detail || event.status;
    statusEl.textContent = value;
    statusKicker.textContent = event.status || "Status";
    if (event.status === "model-thinking") {
      showLive("Myśli...", event.detail || "");
    }
    return;
  }
  if (event.type === "run-start") {
    addEvent("note", "Start", "Rozpoczęto zadanie.");
    showLive("Przygotowuje...");
    return;
  }
  if (event.type === "run-end") {
    statusEl.textContent = "Gotowy";
    statusKicker.textContent = "Gotowy";
    hideLive();
    currentThinkingBubble = null;
    return;
  }
  if (event.type === "note") {
    addEvent("note", "Notatka modelu", event.note);
    showLive("Notatka", event.note);
    return;
  }
  if (event.type === "model-raw") {
    addEvent("tool", "JSON modelu", "", `<pre>${escapeHtml(event.raw)}</pre>`);
    return;
  }

  // ── Thinking stream events ──
  if (event.type === "thinking-start") {
    currentThinkingBubble = createThinkingBubble();
    showLive("Model myśli...");
    return;
  }
  if (event.type === "thinking-delta") {
    if (currentThinkingBubble) {
      appendThinkingText(currentThinkingBubble, event.text);
    }
    // Update live bar with last line of thinking
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

  // ── Tool events with context-aware labels ──
  if (event.type === "tool-start") {
    const label = toolActionLabel(event.tool, event.args);
    addEvent("tool", label, event.note || "", renderJson(event.args || {}));
    showLive(label);
    return;
  }
  if (event.type === "tool-result") {
    if (event.ok) {
      addEvent("tool", `Wynik: ${event.tool}`, "OK", renderJson(event.result));
    } else {
      addEvent("error", `Błąd narzędzia: ${event.tool}`, event.error || "Nieznany błąd");
    }
    return;
  }
  if (event.type === "file-change") {
    addEvent("change", `Edycja: ${event.path}`, event.action, renderDiff(event.diff));
    showLive(`Zapisano: ${event.path}`);
    return;
  }
  if (event.type === "approval-request") {
    addEvent("tool", "Prośba o komendę", `${event.request.cwd}: ${event.request.command}`);
    openApproval(event.request, event.approvalId);
    showLive("Czeka na zatwierdzenie komendy...");
    return;
  }
  if (event.type === "final") {
    if (event.note) addEvent("note", "Podsumowanie modelu", event.note);
    addMessage("assistant", event.text);
    hideLive();
  }
});

refreshState();
setInterval(() => {
  if (!appBusy) refreshState();
}, 5000);
